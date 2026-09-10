import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { MailService } from '../mail/mail.service';
import { redactEmail } from '../mail/redact-email';
import {
  buildCommissionInvoice,
  type CommissionInvoice,
  type IssuerDetails,
} from './commission-invoice';
import { CommissionInvoicePdfService } from './commission-invoice-pdf.service';

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

/** Yukizi's own registered details, from platform settings. */
const ISSUER_SETTING_KEYS = {
  legalName: 'companyLegalName',
  gstin: 'companyGstin',
  address: 'companyAddress',
  state: 'companyState',
  email: 'companyEmail',
} as const;

@Injectable()
export class PayoutEmailService {
  private readonly logger = new Logger(PayoutEmailService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailService: MailService,
    private readonly pdfService: CommissionInvoicePdfService,
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

      const settlement = await this.prisma.sellerSettlement.findUnique({
        where: { id: settlementId },
        include: {
          seller: true,
          orderItem: { select: { orderId: true } },
        },
      });
      if (!settlement) {
        this.logger.warn(`payout-email skipped: settlement ${settlementId} not found`);
        return;
      }

      const recipient = settlement.seller?.email?.trim();
      if (!recipient) {
        // A seller profile can exist without an email; there is genuinely
        // nowhere to send. Countable, so it can be measured.
        this.logger.warn(
          `payout-email skipped: seller ${settlement.sellerId} has no email address`,
        );
        return;
      }

      const invoice = buildCommissionInvoice(settlement, await this.issuer());

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

  /** Platform settings; anything missing degrades the document, never fails it. */
  private async issuer(): Promise<IssuerDetails> {
    try {
      const rows = await this.prisma.systemSetting.findMany({
        where: { key: { in: Object.values(ISSUER_SETTING_KEYS) } },
      });
      const byKey = new Map(rows.map((r) => [r.key, r.value]));
      return {
        legalName: byKey.get(ISSUER_SETTING_KEYS.legalName),
        gstin: byKey.get(ISSUER_SETTING_KEYS.gstin),
        address: byKey.get(ISSUER_SETTING_KEYS.address),
        state: byKey.get(ISSUER_SETTING_KEYS.state),
        email: byKey.get(ISSUER_SETTING_KEYS.email),
      };
    } catch (error) {
      this.logger.warn(
        `payout-email could not read company details: ${(error as Error)?.message}`,
      );
      return {};
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
