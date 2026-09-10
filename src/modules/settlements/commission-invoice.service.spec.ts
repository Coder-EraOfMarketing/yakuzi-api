import { CommissionInvoiceService } from './commission-invoice.service';

/**
 * The issuer block on a commission invoice is Yukizi's own registered
 * identity. Getting it wrong is not a cosmetic bug: a tax invoice carrying no
 * GSTIN — or the wrong one — is one the seller cannot claim input credit
 * against, and it misstates a filing.
 *
 * These values are transcribed from GST registration certificate
 * 27AACCY1892P1ZJ and pinned here so a typo cannot ship quietly.
 */
describe('CommissionInvoiceService — issuer details', () => {
  const settlementRow = {
    id: '15d8cb94-1111-2222-3333-444444444444',
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
      email: 'seller@example.com',
    },
  };

  const build = (settings: Array<{ key: string; value: string }> = []) => {
    const prisma = {
      sellerSettlement: { findUnique: jest.fn().mockResolvedValue(settlementRow) },
      systemSetting: { findMany: jest.fn().mockResolvedValue(settings) },
    };
    return {
      service: new CommissionInvoiceService(prisma as never),
      prisma,
    };
  };

  it('issues in the registered name and GSTIN with no settings stored at all', async () => {
    const { service } = build();

    const invoice = await service.forSettlement(settlementRow.id);

    expect(invoice?.issuer.name).toBe('Yukizi Market Services Private Limited');
    expect(invoice?.issuer.gstin).toBe('27AACCY1892P1ZJ');
    expect(invoice?.issuer.state).toBe('Maharashtra');
    expect(invoice?.issuer.address).toContain('Thane');
    expect(invoice?.issuer.address).toContain('400606');
  });

  it('is a TAX invoice out of the box, not a payout statement', async () => {
    const { service } = build();

    const invoice = await service.forSettlement(settlementRow.id);

    expect(invoice?.isTaxInvoice).toBe(true);
  });

  it('charges IGST to a seller outside Maharashtra', async () => {
    const { service } = build();

    // Registered in Maharashtra, seller in West Bengal.
    const invoice = await service.forSettlement(settlementRow.id);

    expect(invoice?.isIntraState).toBe(false);
    expect(invoice?.igst).toBe(27);
    expect(invoice?.cgst).toBe(0);
  });

  it('splits CGST and SGST for a Maharashtra seller', async () => {
    const prisma = {
      sellerSettlement: {
        findUnique: jest.fn().mockResolvedValue({
          ...settlementRow,
          seller: { ...settlementRow.seller, state: 'Maharashtra' },
        }),
      },
      systemSetting: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new CommissionInvoiceService(prisma as never);

    const invoice = await service.forSettlement(settlementRow.id);

    expect(invoice?.isIntraState).toBe(true);
    expect(invoice?.cgst).toBe(13.5);
    expect(invoice?.sgst).toBe(13.5);
  });

  it('lets a stored setting override a registered detail', async () => {
    const { service } = build([
      { key: 'companyGstin', value: '29NEWGSTIN123Z1' },
      { key: 'companyState', value: 'Karnataka' },
    ]);

    const invoice = await service.forSettlement(settlementRow.id);

    expect(invoice?.issuer.gstin).toBe('29NEWGSTIN123Z1');
    expect(invoice?.issuer.state).toBe('Karnataka');
    // Anything not overridden still comes from the certificate.
    expect(invoice?.issuer.name).toBe('Yukizi Market Services Private Limited');
  });

  it('ignores a blank setting rather than wiping a detail off the invoice', async () => {
    const { service } = build([
      { key: 'companyGstin', value: '   ' },
      { key: 'companyLegalName', value: '' },
    ]);

    const invoice = await service.forSettlement(settlementRow.id);

    expect(invoice?.issuer.gstin).toBe('27AACCY1892P1ZJ');
    expect(invoice?.issuer.name).toBe('Yukizi Market Services Private Limited');
    expect(invoice?.isTaxInvoice).toBe(true);
  });

  it('still issues a complete tax invoice when the settings table is unreachable', async () => {
    const { service, prisma } = build();
    prisma.systemSetting.findMany.mockRejectedValue(new Error('db down'));

    const invoice = await service.forSettlement(settlementRow.id);

    expect(invoice?.issuer.gstin).toBe('27AACCY1892P1ZJ');
    expect(invoice?.isTaxInvoice).toBe(true);
  });

  it('returns null for a settlement that does not exist', async () => {
    const prisma = {
      sellerSettlement: { findUnique: jest.fn().mockResolvedValue(null) },
      systemSetting: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new CommissionInvoiceService(prisma as never);

    await expect(service.forSettlement('nope')).resolves.toBeNull();
  });
});
