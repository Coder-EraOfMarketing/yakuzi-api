import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { isPreOrder } from '../../common/utils/pre-order.util';
import { MailService } from './mail.service';
import { renderEmail, escapeHtml } from './templates/email-layout';
import {
  paragraph,
  button,
  panel,
  productList,
  quote,
  rupees,
  type ProductLine,
} from './templates/email-blocks';
import { sellerLink, SUPPORT_EMAIL } from './templates/email-theme';

/**
 * What a seller hears from Yukizi about their own business.
 *
 * Same three rules as the buyer emails: nothing throws, nothing sends twice,
 * and nothing is sent to an address that does not exist. What differs is the
 * urgency — a seller who is not told an order was cancelled will pack and ship
 * it, and that costs somebody real money.
 */

const KIND = {
  ORDER_CANCELLED: 'seller_order_cancelled',
  STOCK_ALERT: 'seller_stock_alert',
  TICKET_RAISED: 'seller_ticket_raised',
} as const;

const UNIQUE_VIOLATION = 'P2002';

@Injectable()
export class SellerEmailsService {
  private readonly logger = new Logger(SellerEmailsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
  ) {}

  // ────────────────────────────────────────────────────────────
  // 1. An order they were fulfilling is gone
  // ────────────────────────────────────────────────────────────

  /**
   * Tells every seller on a cancelled order to stop.
   *
   * The most time-critical email on the platform: until this existed, a seller
   * could pack, label and hand a cancelled order to a courier without anything
   * telling them otherwise. The subject line says STOP for that reason.
   *
   * One email per seller, listing only their own items — a seller has no
   * business seeing what somebody else supplied on the same order.
   */
  async sendOrderCancelled(orderId: string, reason?: string): Promise<void> {
    await this.guard('seller order-cancelled', async () => {
      const order = await this.prisma.order.findUnique({
        where: { id: orderId },
        select: {
          id: true,
          cancellationReason: true,
          items: {
            select: {
              quantity: true,
              totalPrice: true,
              sellerId: true,
              seller: {
                select: {
                  id: true,
                  companyName: true,
                  user: { select: { email: true } },
                },
              },
              sellerOffer: { select: this.offerSelect() },
            },
          },
        },
      });
      if (!order) return;

      // Group by seller: one order can carry items from several, and each of
      // them needs telling exactly once.
      const bySeller = new Map<string, typeof order.items>();
      for (const item of order.items) {
        const list = bySeller.get(item.sellerId) ?? [];
        list.push(item);
        bySeller.set(item.sellerId, list);
      }

      const ref = this.reference(order.id);
      const why = (reason ?? order.cancellationReason ?? '').trim();

      for (const [sellerId, items] of bySeller) {
        const seller = items[0]?.seller;
        const to = seller?.user?.email;
        if (!to) continue;
        if (!(await this.claim(KIND.ORDER_CANCELLED, `${order.id}:${sellerId}`, sellerId))) {
          continue;
        }

        const lines: ProductLine[] = items.map((item) => ({
          ...this.offerToProductLine(item.sellerOffer),
          meta: item.quantity > 1 ? `Qty ${item.quantity}` : undefined,
          amount: rupees(Number(item.totalPrice)),
        }));

        const html = renderEmail({
          audience: 'seller',
          preheader: `Order ${ref} was cancelled — do not ship it.`,
          eyebrow: 'Order cancelled',
          title: 'Do not ship this order.',
          subtitle: `Order #${ref} has been cancelled. If it is packed, unpack it; if it is with a courier, recall it.`,
          blocks: [
            productList(lines),
            panel(
              [
                { label: 'Order', value: `#${ref}` },
                { label: 'Your items', value: String(items.length) },
              ],
              { tone: 'orange' },
            ),
            why
              ? quote(this.trim(why, 400), 'Reason given')
              : paragraph('No reason was recorded for this cancellation.', {
                  top: 20,
                  size: 14,
                }),
            paragraph(
              'The stock for these items has already been returned to your inventory — there is nothing for you to adjust.',
              { top: 20, size: 14 },
            ),
            button('Open this order', sellerLink('/orders')),
            paragraph(
              `If you have already dispatched it, tell us immediately at <a href="mailto:${SUPPORT_EMAIL}" style="color:#593696;font-weight:600;">${SUPPORT_EMAIL}</a> so we can stop the parcel rather than refund a buyer who is about to receive one.`,
              { top: 20, size: 14 },
            ),
          ],
        });

        const text = [
          `DO NOT SHIP — order #${ref} has been cancelled.`,
          '',
          ...lines.map((l) => `  ${l.name}${l.meta ? ` (${l.meta})` : ''}`),
          '',
          why ? `Reason: ${this.trim(why, 400)}` : 'No reason was recorded.',
          '',
          'The stock has already been returned to your inventory.',
          '',
          `Your orders: ${sellerLink('/orders')}`,
          '',
          `Already dispatched it? Tell us at ${SUPPORT_EMAIL} straight away.`,
          '',
          '— Team Yukizi',
        ].join('\n');

        await this.deliver(
          to,
          `Do not ship — order #${ref} was cancelled`,
          text,
          html,
          KIND.ORDER_CANCELLED,
          `${order.id}:${sellerId}`,
          sellerId,
        );
      }
    });
  }

  // ────────────────────────────────────────────────────────────
  // 2. Stock running out
  // ────────────────────────────────────────────────────────────

  /**
   * Tells a seller a listing is low or empty.
   *
   * The platform has always written these alerts to a table nobody reads. The
   * dedupe key is the product, the state and the day, so a seller hears about
   * a given problem once a day at most however many times stock is touched —
   * and hears again tomorrow if they have still not restocked.
   */
  async sendStockAlert(
    sellerOfferId: string,
    stock: number,
    threshold: number,
  ): Promise<void> {
    await this.guard('seller stock alert', async () => {
      const offer = await this.prisma.sellerOffer.findUnique({
        where: { id: sellerOfferId },
        select: {
          id: true,
          name: true,
          slug: true,
          isActive: true,
          deletedAt: true,
          sellerId: true,
          preOrderDeliveryDate: true,
          seller: {
            select: { companyName: true, user: { select: { email: true } } },
          },
          catalogProduct: {
            select: {
              id: true,
              name: true,
              slug: true,
              images: { orderBy: { order: 'asc' }, take: 1, select: { url: true } },
            },
          },
        },
      });
      // A delisted or deleted product running out is not news. Neither is a
      // pre-order: it has no tracked stock by design — the DEFAULT batch is
      // written at 0 purely so there is a row to update if the seller later
      // turns pre-order off — so "sold out" is not merely unhelpful here, it
      // is false.
      if (!offer || !offer.isActive || offer.deletedAt || isPreOrder(offer)) return;

      const to = offer.seller?.user?.email;
      if (!to) return;

      const empty = stock <= 0;
      const state = empty ? 'out' : 'low';
      // One per product per state per day.
      const day = new Date().toISOString().slice(0, 10);
      const key = `${offer.id}:${state}:${day}`;
      if (!(await this.claim(KIND.STOCK_ALERT, key, offer.sellerId))) return;

      const name = offer.catalogProduct?.name || offer.name;
      const line = this.offerToProductLine(offer);

      const html = renderEmail({
        audience: 'seller',
        preheader: empty
          ? `${name} is out of stock and no longer sellable.`
          : `${name} is down to ${stock} — restock before it sells out.`,
        eyebrow: empty ? 'Out of stock' : 'Low stock',
        title: empty ? 'This has sold out.' : 'This is nearly gone.',
        subtitle: empty
          ? 'Buyers can no longer order it. Every visit to the page from here is a lost sale.'
          : `Only ${stock} left. Collectibles move in bursts, so this can reach zero in a day.`,
        blocks: [
          productList([{ ...line, meta: empty ? 'Sold out' : `${stock} remaining` }]),
          panel(
            [
              { label: 'Stock remaining', value: String(Math.max(0, stock)) },
              { label: 'Low-stock threshold', value: String(threshold) },
            ],
            { tone: empty ? 'orange' : 'purple' },
          ),
          button('Update stock', sellerLink('/inventory'), {
            tone: empty ? 'orange' : 'purple',
          }),
          paragraph(
            'Adding a new batch puts the listing straight back in front of buyers — no re-approval needed.',
            { top: 20, size: 14 },
          ),
        ],
        footerNote:
          'We send this at most once a day per product, and stop as soon as you restock.',
      });

      const text = [
        empty ? `${name} is OUT OF STOCK.` : `${name} is low on stock.`,
        '',
        `Stock remaining: ${Math.max(0, stock)}`,
        `Low-stock threshold: ${threshold}`,
        '',
        `Update stock: ${sellerLink('/inventory')}`,
        '',
        '— Team Yukizi',
      ].join('\n');

      await this.deliver(
        to,
        empty ? `Out of stock: ${name}` : `Low stock: ${name} (${stock} left)`,
        text,
        html,
        KIND.STOCK_ALERT,
        key,
        offer.sellerId,
      );
    });
  }

  // ────────────────────────────────────────────────────────────
  // 3. A buyer has raised something about their order
  // ────────────────────────────────────────────────────────────

  /**
   * Tells the sellers on an order that the buyer has raised a ticket about it.
   *
   * For information, not for action — support owns the conversation and the
   * seller cannot reply into it. What this buys them is warning: a seller who
   * finds out about a complaint when the refund appears has already lost the
   * chance to fix it.
   */
  async sendTicketRaised(ticketId: string): Promise<void> {
    await this.guard('seller ticket-raised', async () => {
      const ticket = await this.prisma.ticket.findUnique({
        where: { id: ticketId },
        select: {
          id: true,
          subject: true,
          orderId: true,
          messages: {
            orderBy: { createdAt: 'asc' },
            take: 1,
            select: { message: true },
          },
          order: {
            select: {
              id: true,
              items: {
                select: {
                  quantity: true,
                  sellerId: true,
                  seller: {
                    select: {
                      id: true,
                      companyName: true,
                      user: { select: { email: true } },
                    },
                  },
                  sellerOffer: { select: this.offerSelect() },
                },
              },
            },
          },
        },
      });
      // Only tickets raised against a specific order can be routed to a
      // seller. A general question has nobody to forward.
      if (!ticket?.order) return;

      const bySeller = new Map<string, typeof ticket.order.items>();
      for (const item of ticket.order.items) {
        const list = bySeller.get(item.sellerId) ?? [];
        list.push(item);
        bySeller.set(item.sellerId, list);
      }

      const ref = this.reference(ticket.order.id);
      const opening = ticket.messages[0]?.message;

      for (const [sellerId, items] of bySeller) {
        const to = items[0]?.seller?.user?.email;
        if (!to) continue;
        if (!(await this.claim(KIND.TICKET_RAISED, `${ticket.id}:${sellerId}`, sellerId))) {
          continue;
        }

        const lines: ProductLine[] = items.map((item) => ({
          ...this.offerToProductLine(item.sellerOffer),
          meta: item.quantity > 1 ? `Qty ${item.quantity}` : undefined,
        }));

        const html = renderEmail({
          audience: 'seller',
          preheader: `A buyer has raised an issue about order ${ref}.`,
          eyebrow: 'Buyer issue',
          title: 'A buyer has raised an issue.',
          subtitle: `It is about order #${ref}, which includes your items.`,
          blocks: [
            panel([{ label: 'Subject', value: ticket.subject }], { tone: 'orange' }),
            productList(lines),
            opening ? quote(this.trim(opening, 800), 'What the buyer told us') : '',
            paragraph(
              '<strong>Yukizi support is handling this</strong> — you do not need to reply, and the buyer has not been given your contact details. We will come to you if we need anything.',
              { top: 22 },
            ),
            paragraph(
              'This is sent so nothing about your products is decided without you knowing. If you already know what went wrong, telling us now is faster than waiting to be asked.',
              { top: 16, size: 14 },
            ),
            button('View the order', sellerLink('/orders')),
          ].filter(Boolean),
        });

        const text = [
          `A buyer has raised an issue about order #${ref}.`,
          '',
          `Subject: ${ticket.subject}`,
          '',
          ...lines.map((l) => `  ${l.name}${l.meta ? ` (${l.meta})` : ''}`),
          '',
          opening ? `What the buyer told us:\n${this.trim(opening, 800)}` : '',
          '',
          'Yukizi support is handling this — you do not need to reply.',
          '',
          `Your orders: ${sellerLink('/orders')}`,
          '',
          '— Team Yukizi',
        ]
          .filter((l) => l !== '')
          .join('\n');

        await this.deliver(
          to,
          `A buyer raised an issue about order #${ref}`,
          text,
          html,
          KIND.TICKET_RAISED,
          `${ticket.id}:${sellerId}`,
          sellerId,
        );
      }
    });
  }

  // ────────────────────────────────────────────────────────────
  // Plumbing — same contract as BuyerEmailsService
  // ────────────────────────────────────────────────────────────

  private async claim(kind: string, dedupeKey: string, userId?: string): Promise<boolean> {
    try {
      await this.prisma.emailDispatch.create({ data: { kind, dedupeKey, userId } });
      return true;
    } catch (error: any) {
      if (error?.code !== UNIQUE_VIOLATION) {
        this.logger.warn(
          `Could not claim ${kind} for ${dedupeKey}: ${error?.message ?? error}`,
        );
      }
      return false;
    }
  }

  private async deliver(
    to: string,
    subject: string,
    text: string,
    html: string,
    kind: string,
    dedupeKey: string,
    sellerId: string,
  ): Promise<void> {
    const result = await this.mail.sendMail({ to, subject, text, html });
    if (result.sent) return;

    if (result.retryable) {
      await this.release(kind, dedupeKey);
      this.logger.warn(`${kind} email deferred for retry (seller ${sellerId})`);
    } else {
      this.logger.warn(`${kind} email could not be sent (seller ${sellerId})`);
    }
  }

  private async release(kind: string, dedupeKey: string): Promise<void> {
    try {
      await this.prisma.emailDispatch.deleteMany({ where: { kind, dedupeKey } });
    } catch {
      // Keeping the claim only costs this one retry.
    }
  }

  private async guard(label: string, work: () => Promise<void>): Promise<void> {
    if (!this.mail.isConfigured()) return;
    try {
      await work();
    } catch (error: any) {
      this.logger.error(`${label} email failed: ${error?.message ?? error}`);
    }
  }

  private offerSelect() {
    return {
      id: true,
      name: true,
      slug: true,
      catalogProduct: {
        select: {
          id: true,
          name: true,
          slug: true,
          images: { orderBy: { order: 'asc' as const }, take: 1, select: { url: true } },
        },
      },
    } as const;
  }

  private offerToProductLine(offer: any): ProductLine {
    const catalog = offer?.catalogProduct;
    const name = catalog?.name || offer?.name || 'Your item';
    return {
      name,
      imageUrl: catalog?.images?.[0]?.url ?? null,
      // Sellers get sent to their own listing, not the storefront page.
      url: sellerLink('/products'),
    };
  }

  private reference(id: string): string {
    return id.slice(0, 8).toUpperCase();
  }

  private trim(value: string, max: number): string {
    const clean = String(value ?? '').trim();
    return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
  }
}
