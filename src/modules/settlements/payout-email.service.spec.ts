import { PayoutEmailService } from './payout-email.service';
import type { CommissionInvoice } from './commission-invoice';
import type { SendMailOptions } from '../mail/mail.service';

/**
 * Marking a settlement paid records that money has already left the building.
 * The guarantee these pin down is that nothing in this service can undo,
 * block or fail that — a seller not getting an email is a nuisance, a payout
 * that appears to fail after the bank transfer went out is not.
 */
describe('PayoutEmailService', () => {
  const SETTLEMENT_ID = '15d8cb94-1111-2222-3333-444444444444';

  const invoice = (over: Partial<CommissionInvoice> = {}): CommissionInvoice => ({
    invoiceNumber: 'YKZ/COM/2026-27/15D8CB94',
    invoiceDate: '2026-08-20T10:00:00.000Z',
    orderReference: 'ABAF6047',
    payoutReference: 'UTR12345',
    issuer: {
      name: 'Yukizi Market Services Private Limited',
      gstin: '19ZZZZZ9999Z1Z9',
      address: 'Kolkata',
      state: 'West Bengal',
      email: 'accounts@yukizi.com',
    },
    seller: {
      name: 'Galazy Enterprises',
      gstin: '19ABCDE1234F1Z5',
      address: 'Kolkata',
      state: 'West Bengal',
      email: 'seller@example.com',
    },
    grossAmount: 1000,
    commissionRatePercent: 15,
    commission: 150,
    gstRate: 18,
    isIntraState: true,
    cgst: 13.5,
    sgst: 13.5,
    igst: 0,
    totalGst: 27,
    totalCharged: 177,
    netPaidToSeller: 823,
    isTaxInvoice: true,
    ...over,
  });

  const build = (
    over: {
      invoice?: CommissionInvoice | null;
      recipient?: string | null;
      mailSent?: boolean;
    } = {},
  ) => {
    const invoiceService = {
      forSettlement: jest
        .fn()
        .mockResolvedValue(over.invoice === undefined ? invoice() : over.invoice),
      recipientFor: jest
        .fn()
        .mockResolvedValue(
          over.recipient === undefined ? 'seller@example.com' : over.recipient,
        ),
    };
    const mailService = {
      isConfigured: jest.fn().mockReturnValue(true),
      sendMail: jest
        .fn()
        .mockResolvedValue({ sent: over.mailSent ?? true, retryable: false }),
    };
    const pdfService = {
      render: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.3 fake')),
      filename: jest.fn().mockReturnValue('YKZ-COM-2026-27-15D8CB94.pdf'),
    };
    const service = new PayoutEmailService(
      mailService as never,
      pdfService as never,
      invoiceService as never,
    );
    return { service, invoiceService, mailService, pdfService };
  };

  it('emails the seller with the commission invoice attached', async () => {
    const { service, mailService } = build();

    await service.settlementPaid(SETTLEMENT_ID);

    expect(mailService.sendMail).toHaveBeenCalledTimes(1);
    const sent = (mailService.sendMail.mock.calls as SendMailOptions[][])[0][0];
    expect(sent.to).toBe('seller@example.com');
    expect(sent.attachments).toHaveLength(1);
    expect(sent.attachments?.[0].contentType).toBe('application/pdf');
    expect(sent.attachments?.[0].filename).toBe('YKZ-COM-2026-27-15D8CB94.pdf');
  });

  it('sends exactly the document the admin previewed', async () => {
    const { service, invoiceService, pdfService } = build();

    await service.settlementPaid(SETTLEMENT_ID);

    // Same loader the preview endpoint calls, so the two cannot drift.
    expect(invoiceService.forSettlement).toHaveBeenCalledWith(SETTLEMENT_ID);
    expect(pdfService.render).toHaveBeenCalledWith(invoice());
  });

  it('shows the seller what was deducted and what reached them', async () => {
    const { service, mailService } = build();

    await service.settlementPaid(SETTLEMENT_ID);

    const sent = (mailService.sendMail.mock.calls as SendMailOptions[][])[0][0];
    expect(sent.text).toContain('150.00'); // commission
    expect(sent.text).toContain('27.00'); // GST on it
    expect(sent.text).toContain('823.00'); // net paid
    expect(sent.text).toContain('UTR12345'); // payment reference
  });

  it('never rejects when the settlement cannot be found', async () => {
    const { service, mailService } = build({ invoice: null });

    await expect(service.settlementPaid(SETTLEMENT_ID)).resolves.toBeUndefined();
    expect(mailService.sendMail).not.toHaveBeenCalled();
  });

  it('never rejects when the seller has no email address', async () => {
    const { service, mailService } = build({ recipient: null });

    await expect(service.settlementPaid(SETTLEMENT_ID)).resolves.toBeUndefined();
    expect(mailService.sendMail).not.toHaveBeenCalled();
  });

  it('never rejects when SMTP is unconfigured, and does not load anything', async () => {
    const { service, invoiceService, mailService } = build();
    mailService.isConfigured.mockReturnValue(false);

    await expect(service.settlementPaid(SETTLEMENT_ID)).resolves.toBeUndefined();
    expect(invoiceService.forSettlement).not.toHaveBeenCalled();
  });

  it('never rejects when building the invoice throws', async () => {
    const { service, invoiceService } = build();
    invoiceService.forSettlement.mockRejectedValue(new Error('db down'));

    await expect(service.settlementPaid(SETTLEMENT_ID)).resolves.toBeUndefined();
  });

  it('never rejects when rendering the PDF throws', async () => {
    const { service, pdfService } = build();
    pdfService.render.mockRejectedValue(new Error('pdfkit exploded'));

    await expect(service.settlementPaid(SETTLEMENT_ID)).resolves.toBeUndefined();
  });

  it('never rejects when the mail server refuses', async () => {
    const { service, mailService } = build({ mailSent: false });

    await expect(service.settlementPaid(SETTLEMENT_ID)).resolves.toBeUndefined();
    expect(mailService.sendMail).toHaveBeenCalled();
  });

  it('still pays the seller the courtesy of an email when the document is only a statement', async () => {
    const { service, mailService } = build({
      invoice: invoice({ isTaxInvoice: false }),
    });

    await service.settlementPaid(SETTLEMENT_ID);

    expect(mailService.sendMail).toHaveBeenCalled();
    const sent = (mailService.sendMail.mock.calls as SendMailOptions[][])[0][0];
    expect(sent.text).toContain('statement');
  });
});
