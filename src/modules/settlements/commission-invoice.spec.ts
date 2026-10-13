import {
  buildCommissionInvoice,
  financialYear,
  type IssuerDetails,
  type SettlementForInvoice,
} from './commission-invoice';

/**
 * The commission invoice bills a SELLER for the fee Yukizi withheld — the
 * mirror of the order invoice, where the seller supplies the buyer. Getting
 * the direction or the tax split wrong here puts a wrong tax document in a
 * business's accounts, so the arithmetic is pinned rather than eyeballed.
 */
describe('buildCommissionInvoice', () => {
  const settlement = (over: Partial<SettlementForInvoice> = {}): SettlementForInvoice => ({
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
      address: '7th floor, Yamuna Building',
      city: 'Kolkata',
      state: 'West Bengal',
      pincode: '700048',
      email: 'seller@example.com',
    },
    ...over,
  });

  const issuer = (over: Partial<IssuerDetails> = {}): IssuerDetails => ({
    legalName: 'Yukizi Market Services Private Limited',
    gstin: '19ZZZZZ9999Z1Z9',
    address: 'Kolkata, West Bengal',
    state: 'West Bengal',
    email: 'accounts@yukizi.com',
    ...over,
  });

  it('bills the seller for the commission and its GST, not the order total', () => {
    const invoice = buildCommissionInvoice(settlement(), issuer());

    expect(invoice.commission).toBe(150);
    expect(invoice.totalGst).toBe(27);
    expect(invoice.totalCharged).toBe(177);
    // The order value is context, never the amount charged.
    expect(invoice.grossAmount).toBe(1000);
  });

  it('names Yukizi as the supplier and the seller as the customer', () => {
    const invoice = buildCommissionInvoice(settlement(), issuer());

    expect(invoice.issuer.name).toContain('Yukizi');
    expect(invoice.issuer.gstin).toBe('19ZZZZZ9999Z1Z9');
    expect(invoice.seller.name).toBe('Galazy Enterprises');
    expect(invoice.seller.gstin).toBe('19ABCDE1234F1Z5');
  });

  it('splits CGST and SGST when both parties are in the same state', () => {
    const invoice = buildCommissionInvoice(settlement(), issuer());

    expect(invoice.isIntraState).toBe(true);
    expect(invoice.cgst).toBe(13.5);
    expect(invoice.sgst).toBe(13.5);
    expect(invoice.igst).toBe(0);
    expect(invoice.cgst + invoice.sgst).toBe(invoice.totalGst);
  });

  it('charges IGST across states', () => {
    const invoice = buildCommissionInvoice(
      settlement({ seller: { ...settlement().seller, state: 'Maharashtra' } }),
      issuer(),
    );

    expect(invoice.isIntraState).toBe(false);
    expect(invoice.igst).toBe(27);
    expect(invoice.cgst).toBe(0);
    expect(invoice.sgst).toBe(0);
  });

  it('keeps the halves adding back to the tax when it will not divide evenly', () => {
    const invoice = buildCommissionInvoice(
      settlement({ commission: 100, commissionGst: 18.01 }),
      issuer(),
    );

    // 9.01 + 9.00 — SGST takes the remainder rather than rounding again, so
    // the two components account for exactly the tax that was deducted.
    // Compared with toBeCloseTo because adding them back in binary floating
    // point gives 18.009999999999998; each printed figure is still exact.
    expect(invoice.cgst).toBe(9.01);
    expect(invoice.sgst).toBe(9);
    expect(invoice.cgst + invoice.sgst).toBeCloseTo(18.01, 2);
  });

  it('does not guess the split when a state is missing', () => {
    const invoice = buildCommissionInvoice(
      settlement({ seller: { ...settlement().seller, state: null } }),
      issuer(),
    );

    expect(invoice.isIntraState).toBe(false);
    expect(invoice.igst).toBe(27);
  });

  it('derives the rates from the money, so they cannot contradict the figures', () => {
    const invoice = buildCommissionInvoice(settlement(), issuer());

    expect(invoice.commissionRatePercent).toBe(15);
    expect(invoice.gstRate).toBe(18);
  });

  /**
   * The client's complaint was that the invoice named a rate they had not
   * configured. #189 fixed what was CHARGED and left the printed rate derived
   * from grossAmount — which includes shipping, while the commission is charged
   * on the product alone. So the figure merely moved: 1.65/17 = 9.71% against a
   * configured 15%, where before it had read 4.97%.
   */
  describe('the printed commission rate', () => {
    // The real order: ₹11 product + ₹6 shipping, 15% commission, 18% GST.
    // Charged 15% × 11 = 1.65, GST 0.30, so ₹9.05 reached the seller.
    const reported = (over: Partial<SettlementForInvoice> = {}) =>
      settlement({
        grossAmount: 17,
        commissionableAmount: 11,
        commission: 1.65,
        commissionGst: 0.3,
        netPayout: 9.05,
        ...over,
      });

    it('states the CONFIGURED rate on a shipping-bearing order', () => {
      const invoice = buildCommissionInvoice(reported(), issuer());

      // 1.65 / 11 = 15%. Dividing by the ₹17 gross would print 9.71%.
      expect(invoice.commissionRatePercent).toBe(15);
      expect(invoice.commissionRatePercent).not.toBe(9.71);
    });

    it('carries the base the commission was charged on, beside the gross', () => {
      const invoice = buildCommissionInvoice(reported(), issuer());

      // Both figures reach the document: the order value the buyer paid, and
      // the product value the fee was taken on. 17 - 11 is the shipping.
      expect(invoice.commissionableAmount).toBe(11);
      expect(invoice.grossAmount).toBe(17);
    });

    it('still derives from grossAmount for a LEGACY settlement', () => {
      // Existing rows are left exactly as they are — no backfill, no
      // recompute — so commissionableAmount is NULL and the gross is the only
      // base there is. It is also the right one: those settlements really were
      // charged on the gross.
      const nulled = buildCommissionInvoice(
        reported({ commissionableAmount: null }),
        issuer(),
      );
      // A row read through a client that does not know the column at all.
      const absent = buildCommissionInvoice(
        reported({ commissionableAmount: undefined }),
        issuer(),
      );

      // 1.65 / 17 = 9.71 — unchanged behaviour for a row written before the fix.
      expect(nulled.commissionRatePercent).toBe(9.71);
      expect(absent.commissionRatePercent).toBe(9.71);
      expect(nulled.commissionableAmount).toBeNull();
      expect(absent.commissionableAmount).toBeNull();
      // Nothing else about the document moves.
      expect(nulled.commission).toBe(1.65);
      expect(nulled.totalGst).toBe(0.3);
      expect(nulled.netPaidToSeller).toBe(9.05);
    });

    it('is unchanged on a zero-shipping order, where base == gross', () => {
      // ₹250 at 13%: 32.50 commission, 5.85 GST. No shipping, so the base and
      // the gross are the same number and the two derivations agree.
      const withBase = buildCommissionInvoice(
        settlement({
          grossAmount: 250,
          commissionableAmount: 250,
          commission: 32.5,
          commissionGst: 5.85,
          netPayout: 211.65,
        }),
        issuer(),
      );
      const withoutBase = buildCommissionInvoice(
        settlement({
          grossAmount: 250,
          commissionableAmount: null,
          commission: 32.5,
          commissionGst: 5.85,
          netPayout: 211.65,
        }),
        issuer(),
      );

      expect(withBase.commissionRatePercent).toBe(13);
      expect(withoutBase.commissionRatePercent).toBe(13);
    });

    it('has no rate to state when the base is zero', () => {
      const invoice = buildCommissionInvoice(
        reported({ commissionableAmount: 0, commission: 0, commissionGst: 0 }),
        issuer(),
      );

      expect(invoice.commissionRatePercent).toBeNull();
    });
  });

  it('is only a TAX invoice when the issuer has a GSTIN on file', () => {
    expect(buildCommissionInvoice(settlement(), issuer()).isTaxInvoice).toBe(true);
    expect(
      buildCommissionInvoice(settlement(), issuer({ gstin: '  ' })).isTaxInvoice,
    ).toBe(false);
  });

  it('numbers from when the settlement was raised, not when it was paid', () => {
    const invoice = buildCommissionInvoice(settlement(), issuer());

    expect(invoice.invoiceNumber).toBe('YKZ/COM/2026-27/15D8CB94');
    expect(invoice.invoiceDate).toBe('2026-08-20T10:00:00.000Z');
  });

  it('gives the same document before and after the payout', () => {
    // An admin previews it while the settlement is still pending, then it is
    // emailed once paid. Same settlement, same tax document — including when
    // the payout lands in the next financial year, which numbering from the
    // payout date would have silently changed.
    const beforePayout = buildCommissionInvoice(
      settlement({ payoutDate: null, payoutReference: null }),
      issuer(),
    );
    const afterPayout = buildCommissionInvoice(
      settlement({ payoutDate: new Date('2027-04-15T10:00:00Z') }),
      issuer(),
    );

    expect(beforePayout.invoiceNumber).toBe(afterPayout.invoiceNumber);
    expect(beforePayout.invoiceDate).toBe(afterPayout.invoiceDate);
    expect(beforePayout.totalCharged).toBe(afterPayout.totalCharged);
  });

  it('carries the order reference and the payout reference for reconciliation', () => {
    const invoice = buildCommissionInvoice(settlement(), issuer());

    expect(invoice.orderReference).toBe('ABAF6047');
    expect(invoice.payoutReference).toBe('UTR12345');
    expect(invoice.netPaidToSeller).toBe(823);
  });

  it('survives a settlement with nothing to charge', () => {
    const invoice = buildCommissionInvoice(
      settlement({ grossAmount: 0, commission: 0, commissionGst: 0, netPayout: 0 }),
      issuer(),
    );

    expect(invoice.totalCharged).toBe(0);
    expect(invoice.commissionRatePercent).toBeNull();
    expect(invoice.gstRate).toBeNull();
  });
});

describe('financialYear', () => {
  it('runs April to March', () => {
    expect(financialYear(new Date('2026-04-01T00:00:00Z'))).toBe('2026-27');
    expect(financialYear(new Date('2026-03-31T00:00:00Z'))).toBe('2025-26');
    expect(financialYear(new Date('2027-01-15T00:00:00Z'))).toBe('2026-27');
  });
});
