import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { InvoiceService, type Invoice } from './invoice.service';
import { InvoicePdfService } from './invoice-pdf.service';
import { MailService, type MailAttachment } from '../mail/mail.service';
import { redactEmail } from '../mail/redact-email';

/**
 * Emails a buyer the tax invoices for orders that have just been paid.
 *
 * Idempotency without a migration: the deploy never runs `prisma migrate deploy`,
 * so there is no table to record sends in. The existing Notification row is the
 * ledger instead — it keys on the order's 8-character reference, it is queryable
 * when someone asks whether an invoice went out, and it doubles as the
 * buyer-visible confirmation in the notification bell.
 *
 * The lookup cannot be scoped by user: it runs before the orders (and therefore
 * the buyer) are loaded. An 8-hex-character reference is unique enough across
 * the order table for that to be safe.
 */

const LEDGER_MARKER = 'tax invoice for order';

/**
 * Why a send did not happen, for callers that need to tell a caller-fixable
 * problem (no email on file) from a server-side one (SMTP unconfigured, or
 * configured but failing) from "there was genuinely nothing to send".
 */
export type InvoiceEmailFailure =
  | 'no-recipient'
  | 'not-configured'
  | 'send-failed'
  | 'nothing-to-send';

export interface InvoiceEmailOutcome {
  sent: boolean;
  reason?: InvoiceEmailFailure;
}

/**
 * One invoice with its rendered PDF, still tied to the order it came from —
 * the buyer's mail carries all of them, the ops copy only those being issued
 * for the first time, and neither should re-render a PDF the other made.
 */
interface OrderDocument {
  orderId: string;
  invoice: Invoice;
  attachment: MailAttachment;
}

@Injectable()
export class InvoiceEmailService {
  private readonly logger = new Logger(InvoiceEmailService.name);

  /** Attempt delays. Overridden in tests to keep them fast. */
  private backoffMs = [2000, 10000, 30000];

  constructor(
    private readonly prisma: PrismaService,
    private readonly invoiceService: InvoiceService,
    private readonly invoicePdfService: InvoicePdfService,
    private readonly mailService: MailService,
  ) {}

  /**
   * Fire-and-forget entry point for the payment path.
   *
   * Deliberately returns void and swallows everything: confirming a payment must
   * never be slowed down, failed or rolled back because an email did not send.
   */
  dispatchForOrders(orderIds: string[]): void {
    void this.sendForOrders(orderIds).catch((error) => {
      this.logger.error(
        `Invoice email dispatch failed: ${(error as Error).message}`,
      );
    });
  }

  /**
   * Sends one email carrying every invoice for the given orders.
   *
   * Orders are split per seller at checkout, so a single cart produces several
   * order rows. They belong to one buyer and one payment, so they belong in one
   * email — three separate emails for one checkout reads as spam.
   */
  async sendForOrders(
    orderIds: string[],
    opts: { force?: boolean } = {},
  ): Promise<InvoiceEmailOutcome> {
    try {
      const ids = Array.from(new Set(orderIds.filter(Boolean)));
      if (ids.length === 0) return { sent: false, reason: 'nothing-to-send' };

      // Orders with no ledger entry yet — the ones being invoiced for the
      // FIRST time. Also what decides whether the ops inbox gets a copy: a
      // buyer pressing "email me my invoice" again must not put another copy
      // in front of the team.
      const unsent = (
        await Promise.all(
          ids.map(async (id) => ((await this.alreadySent(id)) ? null : id)),
        )
      ).filter((id): id is string => id !== null);
      const firstIssue = new Set(unsent);

      const pending = opts.force ? ids : unsent;

      if (pending.length === 0) {
        return { sent: false, reason: 'nothing-to-send' };
      }

      // Checked before any order/buyer lookup: if the box has no SMTP creds,
      // there is no point spending DB round-trips or rendering PDFs only to
      // discard them.
      if (!this.mailService.isConfigured()) {
        this.logger.warn(
          `invoice-email skipped: SMTP is not configured (orders=${pending.length})`,
        );
        return { sent: false, reason: 'not-configured' };
      }

      let orders = await this.prisma.order.findMany({
        where: { id: { in: pending } },
        select: {
          id: true,
          buyerId: true,
          buyer: { select: { id: true, email: true } },
        },
      });
      if (orders.length === 0) {
        return { sent: false, reason: 'nothing-to-send' };
      }

      // Every order in a group shares one buyer — the group comes from a single
      // payment. Enforce it here rather than trusting the caller: a mixed group
      // would email one buyer another buyer's invoice PDFs, which carry their
      // name, address and order contents.
      const buyerId = orders[0].buyerId;
      const foreign = orders.filter((o) => o.buyerId !== buyerId);
      if (foreign.length > 0) {
        this.logger.error(
          `invoice-email: refusing ${foreign.length} order(s) belonging to a different buyer than ${buyerId}`,
        );
        orders = orders.filter((o) => o.buyerId === buyerId);
      }

      const recipient = orders[0].buyer?.email?.trim();

      // Rendered BEFORE the recipient check, not after: a buyer with no email
      // on file is precisely when the ops copy matters, and it needs the same
      // documents. Each PDF is rendered once and both sends attach it.
      const documents: OrderDocument[] = [];
      for (const order of orders) {
        for (const invoice of await this.invoiceService.buildInvoicesForOrder(
          order.id,
        )) {
          documents.push({
            orderId: order.id,
            invoice,
            attachment: {
              filename: this.invoicePdfService.filename(invoice),
              content: await this.invoicePdfService.render(invoice),
              contentType: 'application/pdf',
            },
          });
        }
      }
      if (documents.length === 0) {
        return { sent: false, reason: 'nothing-to-send' };
      }

      const outcome = await this.sendToBuyer(orders, recipient, documents);

      // Attempted whatever happened above, and structurally unable to change
      // what the buyer's caller sees: the outcome is already decided.
      await this.sendOpsCopy(
        documents.filter((d) => firstIssue.has(d.orderId)),
        recipient,
      );

      return outcome;
    } catch (error) {
      // Nothing here may surface to the payment path.
      this.logger.error(`invoice-email failed: ${(error as Error).message}`);
      return { sent: false, reason: 'send-failed' };
    }
  }

  /**
   * Buyer-initiated resend. The caller is responsible for having already proved
   * the buyer owns the order — orders.controller does that through
   * InvoiceService.getInvoicesForOrder, which throws for anyone else.
   */
  async resendForOrder(orderId: string): Promise<InvoiceEmailOutcome> {
    return this.sendForOrders([orderId], { force: true });
  }

  /** The buyer's own copy, and the ledger entry that stops it being sent twice. */
  private async sendToBuyer(
    orders: { id: string; buyerId: string }[],
    recipient: string | undefined,
    documents: OrderDocument[],
  ): Promise<InvoiceEmailOutcome> {
    if (!recipient) {
      // Buyers can register with phone OTP alone, so User.email may be null and
      // there is genuinely nowhere to send. Not an error — but countable, so we
      // can measure how often it happens.
      this.logger.warn(
        `invoice-email skipped: buyer ${orders[0].buyerId} has no email address (orders=${orders.length})`,
      );
      return { sent: false, reason: 'no-recipient' };
    }

    const invoices = documents.map((d) => d.invoice);
    const sent = await this.sendWithRetry(
      recipient,
      invoices,
      documents.map((d) => d.attachment),
    );
    if (!sent) {
      this.logger.error(
        `invoice-email: send failed after retries for buyer ${orders[0].buyerId} (orders=${orders.length})`,
      );
      return { sent: false, reason: 'send-failed' };
    }

    for (const order of orders) {
      await this.writeLedger(order.buyerId, order.id);
    }

    this.logger.log(
      `invoice-email sent to ${redactEmail(recipient)} (orders=${orders.length}, invoices=${invoices.length})`,
    );
    return { sent: true };
  }

  /**
   * The operations copy: the same PDFs, to the Admin Alert Email in platform
   * settings, so someone at Yukizi holds every invoice the platform issues
   * without having to ask the buyer for it.
   *
   * A separate message rather than a bcc on the buyer's, for two reasons: the
   * buyer's mail is addressed to them and reads oddly in a shared inbox, and a
   * bcc would send nothing at all when the buyer has no email address — the one
   * case where the team is the only holder of the document.
   *
   * Never throws and never reports upward. If nobody has set an admin address,
   * this is silently a no-op.
   *
   * Only invoices being issued for the FIRST time reach here, so a buyer
   * resending their own invoice cannot duplicate it. There is deliberately no
   * ops-side ledger — a Notification row belongs to a user, and writing one
   * against the buyer would put "sent to ops" in the buyer's own bell. The one
   * consequence is that if the BUYER's send fails, a later resend re-sends this
   * copy too. A duplicate in an internal inbox is a far smaller problem than a
   * missing invoice, so that trade is deliberate.
   */
  private async sendOpsCopy(
    documents: OrderDocument[],
    buyerRecipient: string | undefined,
  ): Promise<void> {
    if (documents.length === 0) return;

    try {
      const to = (await this.mailService.resolveAdminRecipient())?.trim();
      if (!to) return;
      // An install where the admin address IS the buyer would otherwise get the
      // same PDFs twice.
      if (buyerRecipient && to.toLowerCase() === buyerRecipient.toLowerCase()) {
        return;
      }

      const invoices = documents.map((d) => d.invoice);
      const delivered = await this.deliver({
        to,
        subject:
          invoices.length === 1
            ? `New order ${invoices[0].orderReference} — invoice ${invoices[0].invoiceNumber}`
            : `New order — ${invoices.length} tax invoices`,
        text: this.opsPlainBody(invoices),
        html: this.opsHtmlBody(invoices),
        attachments: documents.map((d) => d.attachment),
      });

      if (delivered) {
        this.logger.log(
          `invoice-email ops copy sent to ${redactEmail(to)} (invoices=${invoices.length})`,
        );
      } else {
        this.logger.error(
          `invoice-email ops copy failed after retries (invoices=${invoices.length})`,
        );
      }
    } catch (error) {
      this.logger.error(
        `invoice-email ops copy failed: ${(error as Error).message}`,
      );
    }
  }

  private async alreadySent(orderId: string): Promise<boolean> {
    const found = await this.prisma.notification.findFirst({
      where: { message: { contains: this.ledgerText(orderId) } },
      select: { id: true },
    });
    return Boolean(found);
  }

  private async writeLedger(userId: string, orderId: string): Promise<void> {
    await this.prisma.notification.create({
      data: {
        userId,
        message: `Your ${this.ledgerText(orderId)} has been emailed to you.`,
      },
    });
  }

  /**
   * The ledger key, and also what the buyer reads in their notification bell.
   * The 8-character order prefix is the same reference the invoice number uses.
   */
  private ledgerText(orderId: string): string {
    return `${LEDGER_MARKER} ${orderId.slice(0, 8).toUpperCase()}`;
  }

  private async sendWithRetry(
    to: string,
    invoices: Invoice[],
    attachments: MailAttachment[],
  ): Promise<boolean> {
    const subject =
      invoices.length === 1
        ? `Your Yukizi tax invoice ${invoices[0].invoiceNumber}`
        : `Your Yukizi tax invoices (${invoices.length})`;

    return this.deliver({
      to,
      subject,
      text: this.plainBody(invoices),
      html: this.htmlBody(invoices),
      attachments,
    });
  }

  /** Send one message, retrying only what SMTP says is worth retrying. */
  private async deliver(message: {
    to: string;
    subject: string;
    text: string;
    html: string;
    attachments: MailAttachment[];
  }): Promise<boolean> {
    for (let attempt = 0; attempt < this.backoffMs.length; attempt++) {
      const result = await this.mailService.sendMail(message);
      if (result.sent) return true;
      if (!result.retryable) return false;

      const wait = this.backoffMs[attempt];
      if (attempt < this.backoffMs.length - 1 && wait > 0) {
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }

    return false;
  }

  /**
   * Written for whoever is watching the shared inbox: who bought, from which
   * seller, for how much. The PDFs carry the detail.
   */
  private opsPlainBody(invoices: Invoice[]): string {
    const total = invoices
      .reduce((sum, i) => sum + i.totalAmount, 0)
      .toFixed(2);
    const list = invoices
      .map(
        (i) =>
          `  ${i.invoiceNumber}  ${i.seller.name || 'Unknown seller'}  Rs. ${i.totalAmount.toFixed(2)}`,
      )
      .join('\n');
    return [
      `Order ${invoices[0].orderReference}`,
      `Buyer: ${invoices[0].buyer.name || 'Not given'}`,
      '',
      `${invoices.length === 1 ? 'Invoice' : 'Invoices'} attached:`,
      list,
      '',
      `Total: Rs. ${total}`,
      '',
      'One invoice per seller — the seller is the supplier of record.',
      'Every invoice is also downloadable from the order in the admin panel.',
      '',
      'Yukizi',
    ].join('\n');
  }

  private opsHtmlBody(invoices: Invoice[]): string {
    const rows = invoices
      .map(
        (i) =>
          `<tr><td style="padding:6px 12px 6px 0;color:#475569">${this.escape(i.invoiceNumber)}</td>` +
          `<td style="padding:6px 12px 6px 0;color:#475569">${this.escape(i.seller.name) || 'Unknown seller'}</td>` +
          `<td style="padding:6px 0;text-align:right;font-weight:600;color:#0f172a">Rs. ${i.totalAmount.toFixed(2)}</td></tr>`,
      )
      .join('');

    return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#0f172a;max-width:560px">
  <p style="font-size:18px;font-weight:700;color:#593696;margin:0 0 16px">Yukizi</p>
  <p style="margin:0 0 4px"><strong>Order ${this.escape(invoices[0].orderReference)}</strong></p>
  <p style="margin:0 0 16px;color:#475569">Buyer: ${this.escape(invoices[0].buyer.name) || 'Not given'}</p>
  <table style="border-collapse:collapse;margin:0 0 16px">${rows}</table>
  <p style="color:#475569;font-size:12px">One invoice per seller — the seller is the supplier of record. Every invoice is also downloadable from the order in the admin panel.</p>
</div>`;
  }

  private plainBody(invoices: Invoice[]): string {
    const total = invoices
      .reduce((sum, i) => sum + i.totalAmount, 0)
      .toFixed(2);
    const list = invoices
      .map((i) => `  ${i.invoiceNumber}  Rs. ${i.totalAmount.toFixed(2)}`)
      .join('\n');
    return [
      `Hello ${invoices[0].buyer.name || 'there'},`,
      '',
      'Thank you for your order. Your tax invoice is attached to this email.',
      '',
      list,
      '',
      `Total: Rs. ${total}`,
      '',
      'Each invoice is issued by the seller who supplied the goods, and generated',
      'by Yukizi on their behalf.',
      '',
      'Need help? Email support@yukizi.com',
      '',
      'Yukizi',
    ].join('\n');
  }

  private htmlBody(invoices: Invoice[]): string {
    const rows = invoices
      .map(
        (i) =>
          `<tr><td style="padding:6px 12px 6px 0;color:#475569">${i.invoiceNumber}</td>` +
          `<td style="padding:6px 0;text-align:right;font-weight:600;color:#0f172a">Rs. ${i.totalAmount.toFixed(2)}</td></tr>`,
      )
      .join('');

    return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#0f172a;max-width:520px">
  <p style="font-size:18px;font-weight:700;color:#593696;margin:0 0 16px">Yukizi</p>
  <p>Hello ${this.escape(invoices[0].buyer.name) || 'there'},</p>
  <p>Thank you for your order. Your tax ${invoices.length === 1 ? 'invoice is' : 'invoices are'} attached to this email.</p>
  <table style="border-collapse:collapse;margin:16px 0">${rows}</table>
  <p style="color:#475569;font-size:12px">Each invoice is issued by the seller who supplied the goods, and generated by Yukizi on their behalf.</p>
  <p style="color:#475569;font-size:12px">Need help? Email <a href="mailto:support@yukizi.com">support@yukizi.com</a></p>
</div>`;
  }

  private escape(value: string): string {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
