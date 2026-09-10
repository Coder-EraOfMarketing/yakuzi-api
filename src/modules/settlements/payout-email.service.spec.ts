import { PayoutEmailService } from './payout-email.service';
import type { SendMailOptions } from '../mail/mail.service';

/**
 * Marking a settlement paid records that money has already left the building.
 * The guarantee these pin down is that nothing in this service can undo,
 * block or fail that — a seller not getting an email is a nuisance, a payout
 * that appears to fail after the bank transfer went out is not.
 */
describe('PayoutEmailService', () => {
  const SETTLEMENT_ID = '15d8cb94-1111-2222-3333-444444444444';

  const build = (
    over: {
      sellerEmail?: string | null;
      settlement?: null;
      settings?: Array<{ key: string; value: string }>;
      mailSent?: boolean;
    } = {},
  ) => {
    const prisma = {
      sellerSettlement: {
        findUnique: jest.fn().mockResolvedValue(
          over.settlement === null
            ? null
            : {
                id: SETTLEMENT_ID,
                sellerId: 'seller-1',
                grossAmount: 1000,
                commission: 150,
                commissionGst: 27,
                netPayout: 823,
                payoutReference: 'UTR12345',
                payoutDate: new Date('2026-09-11T10:00:00Z'),
                createdAt: new Date('2026-08-20T10:00:00Z'),
                orderItem: { orderId: 'abaf6047-9999-8888-7777-666666666666' },
                seller: {
                  companyName: 'Galazy Enterprises',
                  gstNumber: '19ABCDE1234F1Z5',
                  address: '7th floor',
                  city: 'Kolkata',
                  state: 'West Bengal',
                  pincode: '700048',
                  email:
                    over.sellerEmail === undefined
                      ? 'seller@example.com'
                      : over.sellerEmail,
                },
              },
        ),
      },
      systemSetting: {
        findMany: jest.fn().mockResolvedValue(
          over.settings ?? [
            { key: 'companyLegalName', value: 'Yukizi Market Services Private Limited' },
            { key: 'companyGstin', value: '19ZZZZZ9999Z1Z9' },
            { key: 'companyState', value: 'West Bengal' },
          ],
        ),
      },
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
      prisma as never,
      mailService as never,
      pdfService as never,
    );
    return { service, prisma, mailService, pdfService };
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
    const { service, mailService } = build({ settlement: null });

    await expect(service.settlementPaid(SETTLEMENT_ID)).resolves.toBeUndefined();
    expect(mailService.sendMail).not.toHaveBeenCalled();
  });

  it('never rejects when the seller has no email address', async () => {
    const { service, mailService } = build({ sellerEmail: null });

    await expect(service.settlementPaid(SETTLEMENT_ID)).resolves.toBeUndefined();
    expect(mailService.sendMail).not.toHaveBeenCalled();
  });

  it('never rejects when SMTP is unconfigured, and does not touch the database', async () => {
    const { service, prisma, mailService } = build();
    mailService.isConfigured.mockReturnValue(false);

    await expect(service.settlementPaid(SETTLEMENT_ID)).resolves.toBeUndefined();
    expect(prisma.sellerSettlement.findUnique).not.toHaveBeenCalled();
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

  it('still pays the seller the courtesy of an email when no company GSTIN is set', async () => {
    const { service, mailService, pdfService } = build({
      settings: [{ key: 'companyLegalName', value: 'Yukizi' }],
    });

    await service.settlementPaid(SETTLEMENT_ID);

    // Sent, but as a statement — the document must not claim to be a tax
    // invoice the seller could claim input credit against.
    expect(mailService.sendMail).toHaveBeenCalled();
    const invoice = pdfService.render.mock.calls[0][0] as { isTaxInvoice: boolean };
    expect(invoice.isTaxInvoice).toBe(false);
    const sent = (mailService.sendMail.mock.calls as SendMailOptions[][])[0][0];
    expect(sent.text).toContain('statement');
  });

  it('falls back to a bare document when the settings table cannot be read', async () => {
    const { service, prisma, mailService } = build();
    prisma.systemSetting.findMany.mockRejectedValue(new Error('db down'));

    await expect(service.settlementPaid(SETTLEMENT_ID)).resolves.toBeUndefined();
    expect(mailService.sendMail).toHaveBeenCalled();
  });
});
