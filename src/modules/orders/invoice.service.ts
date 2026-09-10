import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

/**
 * Builds tax invoices for an order.
 *
 * Nothing is stored. Every value is derived from the order, its items and the
 * seller and buyer records, so this needs no migration — which matters because
 * the API deploy runs `prisma generate` but never `prisma migrate deploy`, so a
 * new table would exist in the client and not in the database.
 *
 * Following the agreed layout, the SELLER is the supplier of record and Yukizi
 * generates the document on their behalf. An order containing items from more
 * than one seller therefore produces one invoice per seller.
 */

export interface InvoiceLine {
  serial: number;
  description: string;
  quantity: number;
  /** Per unit, excluding tax. */
  unitPrice: number;
  /** Line total excluding tax. */
  taxableValue: number;
  gstRate: number;
  gstAmount: number;
  /** Line total including tax — what the buyer paid. */
  totalAmount: number;
}

export interface InvoiceTaxLine {
  /** The item's GST rate, e.g. 18. */
  rate: number;
  /** What each component is charged at: half the rate intra-state, all of it as IGST otherwise. */
  componentRate: number;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
}

export interface InvoiceParty {
  name: string;
  gstin: string | null;
  address: string;
  phone: string | null;
  email: string | null;
}

export interface Invoice {
  invoiceNumber: string;
  invoiceDate: string;
  orderReference: string;
  /**
   * The supplying seller's profile id — how a caller picks ONE invoice off an
   * order carrying several. The seller's name is not unique, and the invoice
   * number's suffix depends on how many sellers the order happens to have, so
   * neither is safe to address a single document by.
   */
  sellerId: string;
  seller: InvoiceParty;
  buyer: InvoiceParty;
  placeOfSupply: string;
  /** True when seller and buyer are in the same state, so CGST + SGST apply. */
  isIntraState: boolean;
  lines: InvoiceLine[];
  /** Tax stated rate by rate, as a tax invoice requires. */
  taxBreakdown: InvoiceTaxLine[];
  subtotal: number;
  cgst: number;
  sgst: number;
  igst: number;
  totalTax: number;
  totalAmount: number;
  amountInWords: string;
}

const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
  'Seventeen', 'Eighteen', 'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

const ORDER_INCLUDE = {
  address: true,
  // Order.buyer is the User; the GSTIN lives on their buyer profile.
  buyer: {
    select: {
      id: true,
      email: true,
      phone: true,
      buyerProfile: { select: { gstNumber: true } },
    },
  },
  items: {
    include: {
      seller: true,
      sellerOffer: {
        select: { name: true, gstPercent: true, isTaxIncluded: true },
      },
    },
  },
} satisfies Prisma.OrderInclude;

type LoadedOrder = Prisma.OrderGetPayload<{ include: typeof ORDER_INCLUDE }>;

@Injectable()
export class InvoiceService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Invoices for an order, for whoever is allowed to see them — the owning
   * buyer or an admin get every invoice on the order, a seller gets only
   * the invoice(s) for items they themselves supplied. See
   * authorizeAndScope for the authorization/scoping logic.
   *
   * The ownership guard lives here, on the path a request can reach. The
   * system path below deliberately has no user to check.
   */
  async getInvoicesForOrder(userId: string, orderId: string): Promise<Invoice[]> {
    const order = await this.loadOrder(orderId);
    if (!order) throw new NotFoundException('Order not found');

    const scoped = await this.authorizeAndScope(userId, order);
    if (!scoped) {
      throw new ForbiddenException('This order belongs to another account');
    }

    return this.build(scoped);
  }

  /**
   * Who may see this order's invoices, and what they may see of it.
   *
   * The buyer who placed the order and any admin see every invoice on it.
   * A seller sees only invoices for items they themselves supplied — the
   * same multi-seller isolation OrdersService.getOrderDetail already
   * applies, needed here too because build() otherwise produces one
   * invoice per seller present on the order. Keep this filter in sync with
   * that one if the definition of "which items belong to a seller" ever
   * changes.
   *
   * Returns null when the caller may not see this order at all.
   */
  private async authorizeAndScope(
    userId: string,
    order: LoadedOrder,
  ): Promise<LoadedOrder | null> {
    if (order.buyerId === userId) return order;

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true, sellerProfile: { select: { id: true } } },
    });
    if (!user) return null;

    if (user.role === Role.ADMIN) return order;

    if (user.role === Role.SELLER && user.sellerProfile) {
      const sellerId = user.sellerProfile.id;
      const items = order.items.filter((item) => item.sellerId === sellerId);
      if (items.length === 0) return null;
      return { ...order, items };
    }

    return null;
  }

  /**
   * Invoices for an order with no ownership check, for callers that are the
   * system rather than a user — the payment-confirmation email in particular.
   * Returns an empty list rather than throwing, because a missing order is not
   * an error worth failing a background send over.
   */
  async buildInvoicesForOrder(orderId: string): Promise<Invoice[]> {
    const order = await this.loadOrder(orderId);
    if (!order) return [];
    return this.build(order);
  }

  private async loadOrder(orderId: string): Promise<LoadedOrder | null> {
    return this.prisma.order.findUnique({
      where: { id: orderId },
      include: ORDER_INCLUDE,
    });
  }

  private build(order: LoadedOrder): Invoice[] {
    const buyerState = order.address?.state ?? '';

    // One invoice per seller, in a stable order so invoice numbers do not move
    // between requests.
    const bySeller = new Map<string, typeof order.items>();
    for (const item of order.items) {
      const list = bySeller.get(item.sellerId) ?? [];
      list.push(item);
      bySeller.set(item.sellerId, list);
    }

    const sellerIds = Array.from(bySeller.keys()).sort();
    const financialYear = this.financialYear(order.createdAt);
    // Orders have no human-facing number, so the id prefix stands in. It is
    // stable for a given order, which is what the invoice number needs.
    const orderRef = order.id.slice(0, 8).toUpperCase();

    return sellerIds.map((sellerId, index) => {
      const items = bySeller.get(sellerId)!;
      const seller = items[0].seller;

      const lines: InvoiceLine[] = items.map((item, i) => {
        const rate = Number(item.sellerOffer?.gstPercent ?? 0);
        const stored = Number(item.totalPrice);
        const quantity = Number(item.quantity) || 1;

        // Listings record whether their price already contains the tax. When it
        // does, the tax is extracted from the stored figure; when it does not,
        // it is added. Assuming either way would make the invoice total
        // disagree with what the buyer actually paid.
        const taxInclusive = item.sellerOffer?.isTaxIncluded ?? true;
        const taxableValue =
          rate > 0 && taxInclusive ? stored / (1 + rate / 100) : stored;
        const gstAmount = rate > 0 ? (taxInclusive ? stored - taxableValue : taxableValue * (rate / 100)) : 0;
        const gross = taxableValue + gstAmount;

        return {
          serial: i + 1,
          description: item.sellerOffer?.name ?? 'Item',
          quantity,
          unitPrice: this.round(taxableValue / quantity),
          taxableValue: this.round(taxableValue),
          gstRate: rate,
          gstAmount: this.round(gstAmount),
          totalAmount: this.round(gross),
        };
      });

      const subtotal = this.round(lines.reduce((s, l) => s + l.taxableValue, 0));
      const totalAmount = this.round(lines.reduce((s, l) => s + l.totalAmount, 0));

      const isIntraState =
        !!buyerState &&
        !!seller.state &&
        buyerState.trim().toLowerCase() === seller.state.trim().toLowerCase();

      // A tax invoice states the tax rate-wise, not as one merged figure: an
      // order holding a 5% item and an 18% item owes two separate lines.
      const byRate = new Map<number, { taxableValue: number; tax: number }>();
      for (const line of lines) {
        const bucket = byRate.get(line.gstRate) ?? { taxableValue: 0, tax: 0 };
        bucket.taxableValue += line.taxableValue;
        bucket.tax += line.gstAmount;
        byRate.set(line.gstRate, bucket);
      }

      const taxBreakdown: InvoiceTaxLine[] = Array.from(byRate.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([rate, bucket]) => {
          const tax = this.round(bucket.tax);
          // Intra-state splits the rate in half either side; inter-state
          // charges the whole thing as IGST. SGST takes the remainder so the
          // two halves always add back to the tax exactly.
          const cgstAmount = isIntraState ? this.round(tax / 2) : 0;
          return {
            rate,
            // Half the rate each for CGST and SGST, e.g. 5% -> 2.5% + 2.5%.
            componentRate: isIntraState ? rate / 2 : rate,
            taxableValue: this.round(bucket.taxableValue),
            cgst: cgstAmount,
            sgst: isIntraState ? this.round(tax - cgstAmount) : 0,
            igst: isIntraState ? 0 : tax,
          };
        });

      // Totals are summed from the rate lines, so the breakdown and the
      // summary can never disagree.
      const cgst = this.round(taxBreakdown.reduce((s, t) => s + t.cgst, 0));
      const sgst = this.round(taxBreakdown.reduce((s, t) => s + t.sgst, 0));
      const igst = this.round(taxBreakdown.reduce((s, t) => s + t.igst, 0));
      const totalTax = this.round(cgst + sgst + igst);

      const suffix = sellerIds.length > 1 ? `-${index + 1}` : '';

      return {
        invoiceNumber: `YKZ/INV/${financialYear}/${orderRef}${suffix}`,
        invoiceDate: order.createdAt.toISOString(),
        orderReference: `YKZ/ORD/${financialYear}/${orderRef}`,
        sellerId,
        seller: {
          name: seller.companyName,
          gstin: seller.gstNumber ?? null,
          address: [seller.address, seller.city, seller.state, seller.pincode]
            .filter(Boolean)
            .join(', '),
          phone: null,
          email: seller.email ?? null,
        },
        buyer: {
          name: order.address?.name ?? '',
          gstin: order.buyer?.buyerProfile?.gstNumber ?? null,
          address: order.address
            ? [order.address.address, order.address.city, order.address.state, order.address.pincode]
                .filter(Boolean)
                .join(', ')
            : '',
          phone: order.address?.phone ?? order.buyer?.phone ?? null,
          email: order.buyer?.email ?? null,
        },
        placeOfSupply: buyerState,
        isIntraState,
        lines,
        taxBreakdown,
        subtotal,
        cgst,
        sgst,
        igst,
        totalTax,
        totalAmount,
        amountInWords: this.amountInWords(totalAmount),
      };
    });
  }

  private round(n: number): number {
    return Math.round((n + Number.EPSILON) * 100) / 100;
  }

  /** Indian financial year, e.g. 2026-27 for any date from 1 April 2026. */
  private financialYear(date: Date): string {
    const year = date.getFullYear();
    const startYear = date.getMonth() >= 3 ? year : year - 1;
    return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
  }

  private amountInWords(amount: number): string {
    const rupees = Math.floor(amount);
    const paise = Math.round((amount - rupees) * 100);
    const words = `${this.numberToWords(rupees)} Rupees`;
    return paise > 0
      ? `${words} and ${this.numberToWords(paise)} Paise Only`
      : `${words} Only`;
  }

  /** Indian numbering: crore, lakh, thousand, hundred. */
  private numberToWords(n: number): string {
    if (n === 0) return 'Zero';
    const parts: string[] = [];
    const push = (value: number, label: string) => {
      if (value > 0) parts.push(`${this.twoDigits(value)} ${label}`.trim());
    };
    push(Math.floor(n / 10000000), 'Crore');
    n %= 10000000;
    push(Math.floor(n / 100000), 'Lakh');
    n %= 100000;
    push(Math.floor(n / 1000), 'Thousand');
    n %= 1000;
    push(Math.floor(n / 100), 'Hundred');
    n %= 100;
    if (n > 0) parts.push(this.twoDigits(n));
    return parts.join(' ');
  }

  private twoDigits(n: number): string {
    if (n < 20) return ONES[n];
    const tens = TENS[Math.floor(n / 10)];
    const ones = ONES[n % 10];
    return ones ? `${tens} ${ones}` : tens;
  }
}
