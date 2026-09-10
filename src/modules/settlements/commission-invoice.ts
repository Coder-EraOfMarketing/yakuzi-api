import { Decimal } from '@prisma/client/runtime/library';

/**
 * The commission invoice: Yukizi billing a SELLER for the marketplace fee it
 * withheld from a payout.
 *
 * This is the mirror of the order invoice and must not be confused with it.
 * There, the seller supplies goods to a buyer and Yukizi renders the document
 * on their behalf. Here Yukizi is the supplier, the seller is the customer,
 * and the supply is a service — the commission, on which GST has already been
 * charged and deducted at source by the payout calculator.
 *
 * Nothing is stored: every figure is derived from the settlement row that was
 * written when the order was delivered. That matters because the deploy runs
 * `prisma generate` but never `prisma migrate deploy`, so a new table would
 * exist in the client and not in the database.
 */

export interface CommissionInvoiceParty {
  name: string;
  gstin: string | null;
  address: string;
  state: string | null;
  email: string | null;
}

export interface CommissionInvoice {
  /** YKZ/COM/<FY>/<settlement ref> — derived, stable, unique per settlement. */
  invoiceNumber: string;
  invoiceDate: string;
  /** The order this commission was charged on, for the seller to reconcile. */
  orderReference: string;
  /** Bank/UPI reference the admin recorded when paying out. */
  payoutReference: string | null;
  issuer: CommissionInvoiceParty;
  seller: CommissionInvoiceParty;
  /** What the buyer paid for the item, the base the commission is taken from. */
  grossAmount: number;
  commissionRatePercent: number | null;
  /** The taxable value of this supply. */
  commission: number;
  gstRate: number | null;
  /** True when issuer and seller are in the same state, so CGST + SGST apply. */
  isIntraState: boolean;
  cgst: number;
  sgst: number;
  igst: number;
  totalGst: number;
  /** Commission + GST — what was withheld. */
  totalCharged: number;
  /** What actually reached the seller for this item. */
  netPaidToSeller: number;
  /**
   * A tax invoice must carry the issuer's GSTIN. Without it this document is
   * a payout statement, and says so, rather than pretending to be something
   * a seller could claim input credit against.
   */
  isTaxInvoice: boolean;
}

export interface SettlementForInvoice {
  id: string;
  grossAmount: Decimal | number | string;
  commission: Decimal | number | string;
  commissionGst: Decimal | number | string;
  netPayout: Decimal | number | string;
  payoutReference?: string | null;
  payoutDate?: Date | null;
  createdAt: Date;
  orderItem?: { orderId?: string | null } | null;
  seller?: {
    companyName?: string | null;
    gstNumber?: string | null;
    address?: string | null;
    city?: string | null;
    state?: string | null;
    pincode?: string | null;
    email?: string | null;
  } | null;
}

/** Yukizi's own registered details, from platform settings. */
export interface IssuerDetails {
  legalName?: string | null;
  gstin?: string | null;
  address?: string | null;
  state?: string | null;
  email?: string | null;
}

const num = (value: Decimal | number | string | null | undefined): number =>
  value == null ? 0 : Number(value);

const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * Indian financial year, April to March — 2026-05-01 is FY 2026-27, and
 * 2026-02-01 is still 2025-26. Invoice numbers are scoped to it.
 */
export function financialYear(date: Date): string {
  const year = date.getFullYear();
  const startYear = date.getMonth() >= 3 ? year : year - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

export function buildCommissionInvoice(
  settlement: SettlementForInvoice,
  issuer: IssuerDetails,
): CommissionInvoice {
  const issuedOn = settlement.payoutDate ?? settlement.createdAt;

  const grossAmount = round2(num(settlement.grossAmount));
  const commission = round2(num(settlement.commission));
  const totalGst = round2(num(settlement.commissionGst));
  const netPaidToSeller = round2(num(settlement.netPayout));

  const issuerState = (issuer.state ?? '').trim();
  const sellerState = (settlement.seller?.state ?? '').trim();
  // Both states must be known before the tax can be split. An unknown one is
  // left as inter-state rather than guessed: naming the wrong components on a
  // tax invoice is worse than naming one.
  const isIntraState =
    !!issuerState &&
    !!sellerState &&
    issuerState.toLowerCase() === sellerState.toLowerCase();

  // CGST takes the rounded half and SGST the remainder, so the two always add
  // back to the tax that was actually deducted.
  const cgst = isIntraState ? round2(totalGst / 2) : 0;
  const sgst = isIntraState ? round2(totalGst - cgst) : 0;
  const igst = isIntraState ? 0 : totalGst;

  const sellerAddress = [
    settlement.seller?.address,
    settlement.seller?.city,
    settlement.seller?.state,
    settlement.seller?.pincode,
  ]
    .filter(Boolean)
    .join(', ');

  const reference = settlement.id.slice(0, 8).toUpperCase();
  const orderReference = settlement.orderItem?.orderId
    ? settlement.orderItem.orderId.slice(0, 8).toUpperCase()
    : '';

  return {
    invoiceNumber: `YKZ/COM/${financialYear(issuedOn)}/${reference}`,
    invoiceDate: issuedOn.toISOString(),
    orderReference,
    payoutReference: settlement.payoutReference ?? null,
    issuer: {
      name: issuer.legalName?.trim() || 'Yukizi',
      gstin: issuer.gstin?.trim() || null,
      address: issuer.address?.trim() || '',
      state: issuerState || null,
      email: issuer.email?.trim() || null,
    },
    seller: {
      name: settlement.seller?.companyName ?? '',
      gstin: settlement.seller?.gstNumber ?? null,
      address: sellerAddress,
      state: sellerState || null,
      email: settlement.seller?.email ?? null,
    },
    grossAmount,
    // Derived rather than stored: the settlement keeps the money, not the rate
    // it came from, and a rate printed on an invoice has to agree with the
    // figures beside it.
    commissionRatePercent:
      grossAmount > 0 ? round2((commission / grossAmount) * 100) : null,
    commission,
    gstRate: commission > 0 ? round2((totalGst / commission) * 100) : null,
    isIntraState,
    cgst,
    sgst,
    igst,
    totalGst,
    totalCharged: round2(commission + totalGst),
    netPaidToSeller,
    isTaxInvoice: Boolean(issuer.gstin?.trim()),
  };
}
