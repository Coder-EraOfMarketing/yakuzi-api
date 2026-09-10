import { Injectable, Logger } from '@nestjs/common';
import { MailService } from '../mail/mail.service';
import { redactEmail } from '../mail/redact-email';
import { type CommissionInvoice } from './commission-invoice';
import { CommissionInvoicePdfService } from './commission-invoice-pdf.service';
import { CommissionInvoiceService } from './commission-invoice.service';

/**
 * Tells a seller their payout has gone out, and attaches the commission
 * invoice for the fee that was withheld from it.
 *
 * Before this, a seller was paid a net figure with no document explaining the
 * difference: the commission and its GST were deducted at source and nothing
 * was ever issued for them.
 *
 * Fire-and-forget by contract. Marking a settlement paid records that money
 * has moved; an email that will not send must never undo or block that.
 */

@Injectable()
export class PayoutEmailService {
  private readonly logger = new Logger(PayoutEmailService.name);

  constructor(
    private readonly mailService: MailService,
    private readonly pdfService: CommissionInvoicePdfService,
    // The same loader the admin preview uses, so what an admin checked before
    // paying is by construction the document that lands with the seller.
    private readonly invoiceService: CommissionInvoiceService,
  ) {}

  /**
   * Entry point for the admin payout path. Returns rather than throws, and
   * callers are expected to `void` it.
   */
  async settlementPaid(settlementId: string): Promise<void> {
    try {
      if (!this.mailService.isConfigured()) {
        this.logger.warn(
          `payout-email skipped: SMTP is not configured (settlement=${settlementId})`,
        );
        return;
      }

      const invoice = await this.invoiceService.forSettlement(settlementId);
      if (!invoice) {
        this.logger.warn(`payout-email skipped: settlement ${settlementId} not found`);
        return;
      }

      const recipient = await this.invoiceService.recipientFor(settlementId);
      if (!recipient) {
        // A seller profile can exist without an email; there is genuinely
        // nowhere to send. Countable, so it can be measured.
        this.logger.warn(
          `payout-email skipped: settlement ${settlementId} has no seller email`,
        );
        return;
      }

      if (!invoice.isTaxInvoice) {
        // Still worth sending — the seller wants to know they were paid — but
        // loud in the logs, because every one of these is a document the
        // seller cannot claim input credit against.
        this.logger.warn(
          `payout-email: no companyGstin configured, sending ${invoice.invoiceNumber} as a payout statement rather than a tax invoice`,
        );
      }

      const pdf = await this.pdfService.render(invoice);

      const result = await this.mailService.sendMail({
        to: recipient,
        subject: `Payout sent — ${invoice.orderReference || invoice.invoiceNumber}`,
        text: this.plainBody(invoice),
        html: this.htmlBody(invoice),
        attachments: [
          {
            filename: this.pdfService.filename(invoice),
            content: pdf,
            contentType: 'application/pdf',
          },
        ],
      });

      if (result.sent) {
        this.logger.log(
          `payout-email sent to ${redactEmail(recipient)} (settlement=${settlementId})`,
        );
      } else {
        this.logger.error(
          `payout-email not sent for settlement ${settlementId}, retryable=${result.retryable}`,
        );
      }
    } catch (error) {
      // Nothing here may surface to the admin marking the payout.
      this.logger.error(
        `payout-email failed for settlement ${settlementId}: ${(error as Error)?.message}`,
      );
    }
  }

  private plainBody(invoice: CommissionInvoice): string {
    const money = (n: number) => `Rs. ${n.toFixed(2)}`;
    return [
      `Hello ${invoice.seller.name || 'there'},`,
      '',
      `Your payout for order ${invoice.orderReference || DASHLESS} has been sent.`,
      '',
      `Order value:        ${money(invoice.grossAmount)}`,
      `Commission:         ${money(invoice.commission)}`,
      `GST on commission:  ${money(invoice.totalGst)}`,
      `Paid to you:        ${money(invoice.netPaidToSeller)}`,
      ...(invoice.payoutReference
        ? ['', `Payment reference: ${invoice.payoutReference}`]
        : []),
      '',
      invoice.isTaxInvoice
        ? 'The tax invoice for the commission is attached.'
        : 'A statement for the commission is attached.',
      '',
      'Yukizi',
    ].join('\n');
  }

  private htmlBody(invoice: CommissionInvoice): string {
    const money = (n: number) => `Rs. ${n.toFixed(2)}`;
    const row = (label: string, value: string, bold = false) =>
      `<tr><td style="padding:4px 16px 4px 0;color:#475569">${label}</td>` +
      `<td style="padding:4px 0;text-align:right;${bold ? 'font-weight:700;' : ''}color:#0f172a">${value}</td></tr>`;

    return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#0f172a;max-width:520px">
  <p style="font-size:18px;font-weight:700;color:#593696;margin:0 0 16px">Yukizi</p>
  <p>Hello ${this.escape(invoice.seller.name) || 'there'},</p>
  <p>Your payout for order <strong>${this.escape(invoice.orderReference)}</strong> has been sent.</p>
  <table style="border-collapse:collapse;margin:16px 0">
    ${row('Order value', money(invoice.grossAmount))}
    ${row('Commission', money(invoice.commission))}
    ${row('GST on commission', money(invoice.totalGst))}
    ${row('Paid to you', money(invoice.netPaidToSeller), true)}
  </table>
  ${invoice.payoutReference ? `<p style="color:#475569;font-size:12px">Payment reference: ${this.escape(invoice.payoutReference)}</p>` : ''}
  <p style="color:#475569;font-size:12px">${invoice.isTaxInvoice ? 'The tax invoice for the commission is attached.' : 'A statement for the commission is attached.'}</p>
</div>`;
  }

  private escape(value: string | null): string {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}

/** Plain-text stand-in for a missing order reference. */
const DASHLESS = '(reference unavailable)';
