import {
  buildPayoutInputFromOrderItem,
  calculateSellerPayout,
  PayoutInput,
} from './payout-calculator';

function input(overrides: Partial<PayoutInput> = {}): PayoutInput {
  return {
    baseSellingPrice: 500,
    quantity: 1,
    finalShippingPrice: 50,
    commissionPercent: 10,
    commissionGstPercent: 18,
    ...overrides,
  };
}

describe('calculateSellerPayout', () => {
  // Test 1: Standard Calculation
  it('should correctly calculate payout for a standard order', () => {
    // Gross = (500 × 1) + 50 = 550
    // Commissionable = 550 - 50 = 500 (shipping is never commissioned)
    // Commission = 500 × 10% = 50
    // CommissionGST = 50 × 18% = 9.00
    // Total Deductions = 50 + 9.00 + 50 = 109.00
    // Net Payout = 550 - 109.00 = 441.00

    const result = calculateSellerPayout(input());

    expect(result.grossAmount.toFixed(2)).toBe('550.00');
    expect(result.commission.toFixed(2)).toBe('50.00');
    expect(result.commissionGst.toFixed(2)).toBe('9.00');
    expect(result.finalShippingPrice.toFixed(2)).toBe('50.00');
    expect(result.netPayout.toFixed(2)).toBe('441.00');
    expect(result.status).toBe('PENDING');
  });

  // Test 2: Multi-Quantity Order
  it('should scale gross correctly for multi-quantity orders', () => {
    // Gross = (200 × 3) + 30 = 630
    // Commissionable = 630 - 30 = 600
    // Commission = 600 × 5% = 30.00
    // CommissionGST = 30.00 × 18% = 5.40
    // Total Deductions = 30.00 + 5.40 + 30 = 65.40
    // Net Payout = 630 - 65.40 = 564.60

    const result = calculateSellerPayout(
      input({
        baseSellingPrice: 200,
        quantity: 3,
        finalShippingPrice: 30,
        commissionPercent: 5,
      }),
    );

    expect(result.grossAmount.toFixed(2)).toBe('630.00');
    expect(result.commission.toFixed(2)).toBe('30.00');
    expect(result.netPayout.toFixed(2)).toBe('564.60');
    expect(result.status).toBe('PENDING');
  });

  // Test 3: Deficit / Zero-Payout Safety
  it('should set status to DEFICIT_ESCALATED and clamp payout to 0 when fees exceed gross', () => {
    // Very low price, high commission, high shipping => deficit
    // Gross = (10 × 1) + 50 = 60
    // Commissionable = 60 - 50 = 10
    // Commission = 10 × 95% = 9.50
    // CommissionGST = 9.50 × 18% = 1.71
    // Total Deductions = 9.50 + 1.71 + 50 = 61.21
    // Net Payout (raw) = 60 - 61.21 = -1.21 → clamped to 0
    // Still a deficit after the base change, but a far smaller one: the
    // withheld shipping alone now outruns the gross.

    const result = calculateSellerPayout(
      input({
        baseSellingPrice: 10,
        quantity: 1,
        finalShippingPrice: 50,
        commissionPercent: 95,
      }),
    );

    expect(result.commission.toFixed(2)).toBe('9.50');
    expect(result.totalDeductions.toFixed(2)).toBe('61.21');
    expect(result.netPayout.toFixed(2)).toBe('0.00');
    expect(result.status).toBe('DEFICIT_ESCALATED');
  });

  // Test 4: Rounding Edge-Case
  it('should correctly round fractional Decimal results to 2 decimal places', () => {
    // Gross = (333.33 × 1) + 0 = 333.33
    // Commission = 333.33 × 7% = 23.3331 → rounds to 23.33
    // CommissionGST = 23.33 × 18% = 4.1994 → rounds to 4.20
    // Total Deductions = 23.33 + 4.20 + 0 = 27.53
    // Net = 333.33 - 27.53 = 305.80

    const result = calculateSellerPayout(
      input({
        baseSellingPrice: 333.33,
        quantity: 1,
        finalShippingPrice: 0,
        commissionPercent: 7,
      }),
    );

    expect(result.commission.toFixed(2)).toBe('23.33');
    expect(result.commissionGst.toFixed(2)).toBe('4.20');
    expect(result.netPayout.toFixed(2)).toBe('305.80');
    expect(result.status).toBe('PENDING');
  });

  // Test 5: Zero-rate Catalog Product
  it('should work correctly when all catalog rates are zero', () => {
    // Gross = (1000 × 1) + 100 = 1100
    // Commission = 0, GST = 0
    // Net Payout = 1100 - (0 + 0 + 100) = 1000

    const result = calculateSellerPayout(
      input({
        baseSellingPrice: 1000,
        finalShippingPrice: 100,
        commissionPercent: 0,
        commissionGstPercent: 0,
      }),
    );

    expect(result.grossAmount.toFixed(2)).toBe('1100.00');
    expect(result.commission.toFixed(2)).toBe('0.00');
    expect(result.netPayout.toFixed(2)).toBe('1000.00');
    expect(result.status).toBe('PENDING');
  });

  // ─── THE COMMISSION BASE ──────────────────────────────
  // Shipping is in the gross but never in the commission base, whoever booked
  // the courier. The platform's cut is earned on the product, not on a courier
  // bill it passed through.
  describe('the commission base excludes shipping', () => {
    // The live order from the bug report: ₹11 product, ₹6 shipping, 15%/18%,
    // platform-shipped. Production billed 5% of the ₹17 total with no GST.
    const reported = input({
      baseSellingPrice: 11,
      quantity: 1,
      finalShippingPrice: 6,
      commissionPercent: 15,
      commissionGstPercent: 18,
    });

    /**
     * RETURNED, not just computed internally. The settlement row records it,
     * and the commission invoice divides the fee by it to state the rate: the
     * stored grossAmount includes shipping, so there is no other way to
     * recover the configured percentage after the fact.
     */
    it('returns the commissionable base it charged on', () => {
      const result = calculateSellerPayout(reported);

      expect(result.commissionableAmount.toFixed(2)).toBe('11.00');
      // Gross minus the shipping, and the base the fee divides back into.
      expect(
        result.grossAmount.minus(result.commissionableAmount).toFixed(2),
      ).toBe('6.00');
      expect(
        result.commission.dividedBy(result.commissionableAmount).times(100).toFixed(2),
      ).toBe('15.00');
    });

    it('returns the same base whoever booked the courier', () => {
      const self = calculateSellerPayout({
        ...reported,
        sellerKeepsShipping: true,
      });

      expect(self.commissionableAmount.toFixed(2)).toBe('11.00');
    });

    it('returns a base equal to the gross when there is no shipping', () => {
      const result = calculateSellerPayout({
        ...reported,
        finalShippingPrice: 0,
      });

      expect(result.commissionableAmount.toFixed(2)).toBe('11.00');
      expect(result.grossAmount.toFixed(2)).toBe('11.00');
    });

    it('commissions the product only on a PLATFORM-shipped order', () => {
      // Gross = 11 + 6 = 17
      // Commissionable = 11 — NOT 17, which would have charged 2.55
      // Commission = 11 × 15% = 1.65
      // CommissionGST = 1.65 × 18% = 0.297 → 0.30
      const result = calculateSellerPayout(reported);

      expect(result.grossAmount.toFixed(2)).toBe('17.00');
      expect(result.commission.toFixed(2)).toBe('1.65');
      expect(result.commissionGst.toFixed(2)).toBe('0.30');
    });

    it('charges the same commission whoever shipped it', () => {
      const platform = calculateSellerPayout(reported);
      const self = calculateSellerPayout({
        ...reported,
        sellerKeepsShipping: true,
      });

      // The ONE thing fulfilment mode decides is withholding, so the fee is
      // identical and only the shipping line differs.
      expect(self.commission.toFixed(2)).toBe(platform.commission.toFixed(2));
      expect(self.commissionGst.toFixed(2)).toBe(
        platform.commissionGst.toFixed(2),
      );
    });

    it('deducts the withheld shipping from netPayout when platform-shipped', () => {
      // Deductions = 1.65 + 0.30 + 6 (withheld) = 7.95
      // Net = 17 - 7.95 = 9.05
      const result = calculateSellerPayout(reported);

      expect(result.finalShippingPrice.toFixed(2)).toBe('6.00');
      expect(result.buyerPaidShipping.toFixed(2)).toBe('6.00');
      expect(result.totalDeductions.toFixed(2)).toBe('7.95');
      expect(result.netPayout.toFixed(2)).toBe('9.05');
    });

    it('withholds nothing on self-ship, so the seller keeps the shipping', () => {
      // Deductions = 1.65 + 0.30 + 0 = 1.95
      // Net = 17 - 1.95 = 15.05
      const result = calculateSellerPayout({
        ...reported,
        sellerKeepsShipping: true,
      });

      expect(result.finalShippingPrice.toFixed(2)).toBe('0.00');
      expect(result.buyerPaidShipping.toFixed(2)).toBe('6.00');
      expect(result.totalDeductions.toFixed(2)).toBe('1.95');
      expect(result.netPayout.toFixed(2)).toBe('15.05');
    });

    // The same invariant on the ₹500 + ₹50 fixture, both modes asserted side
    // by side: 500 × 10% either way, shipping in the gross for both and
    // withheld only when the platform booked the courier.
    it('never charges commission on shipping, platform-shipped or not', () => {
      const platform = calculateSellerPayout(input({ sellerKeepsShipping: false }));
      const selfShip = calculateSellerPayout(input({ sellerKeepsShipping: true }));

      expect(platform.commission.toFixed(2)).toBe('50.00');
      expect(selfShip.commission.toFixed(2)).toBe('50.00');

      expect(platform.grossAmount.toFixed(2)).toBe('550.00');
      expect(selfShip.grossAmount.toFixed(2)).toBe('550.00');
      expect(platform.finalShippingPrice.toFixed(2)).toBe('50.00');
      expect(selfShip.finalShippingPrice.toFixed(2)).toBe('0.00');
    });
  });

  // Test 6: Self-ship — the seller booked the courier, so the shipping the
  // buyer paid is theirs. These are the numbers from the bug report's product:
  // ₹1,600 base, 15% commission, 18% GST on fees, ₹150 seller-set shipping.
  describe('when the seller shipped it themselves', () => {
    const selfShip = input({
      baseSellingPrice: 1600,
      quantity: 1,
      finalShippingPrice: 150,
      commissionPercent: 15,
      commissionGstPercent: 18,
      sellerKeepsShipping: true,
    });

    it('withholds no shipping and earns no commission on it', () => {
      // Gross = 1600 + 150 = 1750 (the buyer really did pay the shipping)
      // Commission = 15% of 1600, NOT of 1750 = 240
      // CommissionGST = 240 × 18% = 43.20
      // Deductions = 240 + 43.20 + 0 = 283.20
      // Net = 1750 - 283.20 = 1466.80
      const result = calculateSellerPayout(selfShip);

      expect(result.grossAmount.toFixed(2)).toBe('1750.00');
      expect(result.buyerPaidShipping.toFixed(2)).toBe('150.00');
      expect(result.finalShippingPrice.toFixed(2)).toBe('0.00');
      expect(result.commission.toFixed(2)).toBe('240.00');
      expect(result.commissionGst.toFixed(2)).toBe('43.20');
      expect(result.totalDeductions.toFixed(2)).toBe('283.20');
      expect(result.netPayout.toFixed(2)).toBe('1466.80');
    });

    it('leaves the seller better off by exactly the shipping', () => {
      const platform = calculateSellerPayout({
        ...selfShip,
        sellerKeepsShipping: false,
      });
      const seller = calculateSellerPayout(selfShip);

      // Both are commissioned on the ₹1,600 product, so the only difference
      // left is the ₹150 the platform withholds when it booked the courier.
      // Platform: 1750 - (240 + 43.20 + 150) = 1316.80.
      expect(platform.netPayout.toFixed(2)).toBe('1316.80');
      // Fulfilment mode no longer drags commission along with it. (It used to:
      // platform-shipped charged 15% of the ₹1750 gross, making the gap
      // 150 + 22.50 + 4.05 = 176.55.)
      expect(platform.commission.toFixed(2)).toBe(seller.commission.toFixed(2));
      expect(seller.netPayout.minus(platform.netPayout).toFixed(2)).toBe(
        '150.00',
      );
    });

    it('defaults to withholding shipping when the flag is absent', () => {
      const { sellerKeepsShipping, ...withoutFlag } = selfShip;
      const result = calculateSellerPayout(withoutFlag);

      expect(result.finalShippingPrice.toFixed(2)).toBe('150.00');
    });
  });

  describe('GST on the commission', () => {
    it('applies the configured rate', () => {
      const result = calculateSellerPayout(
        input({
          baseSellingPrice: 1000,
          finalShippingPrice: 0,
          commissionPercent: 10,
          commissionGstPercent: 5,
        }),
      );

      expect(result.commission.toFixed(2)).toBe('100.00');
      expect(result.commissionGst.toFixed(2)).toBe('5.00');
    });

    it('defaults to 18, never 0, when the rate is unset', () => {
      // A missing rate means "nobody configured it", not "exempt". Billing it
      // at 0% is what produced commission invoices reading "IGST @ 0%".
      const result = calculateSellerPayout({
        baseSellingPrice: 1000,
        quantity: 1,
        finalShippingPrice: 0,
        commissionPercent: 10,
      } as unknown as PayoutInput);

      expect(result.commission.toFixed(2)).toBe('100.00');
      expect(result.commissionGst.toFixed(2)).toBe('18.00');
    });
  });
});

describe('buildPayoutInputFromOrderItem', () => {
  const rates = (over: Record<string, unknown> = {}) => ({
    commissionPercent: null,
    commissionGstPercent: null,
    subCategory: null,
    category: null,
    ...over,
  });

  const orderItem = (offer: Record<string, unknown>) => ({
    id: 'item-1',
    sellerId: 'seller-1',
    unitPrice: 100,
    quantity: 1,
    sellerOffer: { finalShippingPrice: null, shippingCharges: null, ...offer },
  });

  it('reads the rate off an offer linked DIRECTLY to a catalogue product', () => {
    // SellerOffer.catalogProductId, with no variant at all. Every settlement
    // writer used to follow sellerOffer.variant.catalogProduct only, so this
    // listing silently settled at 0% commission and 0% GST.
    const input = buildPayoutInputFromOrderItem(
      orderItem({
        catalogProduct: rates({
          commissionPercent: 15,
          commissionGstPercent: 18,
        }),
        variant: null,
      }),
      false,
    );

    expect(input.commissionPercent).toBe(15);
    expect(input.commissionGstPercent).toBe(18);
  });

  it('still reads the rate off an offer linked THROUGH a variant', () => {
    const input = buildPayoutInputFromOrderItem(
      orderItem({
        catalogProduct: null,
        variant: {
          catalogProduct: rates({
            commissionPercent: 13,
            commissionGstPercent: 18,
          }),
        },
      }),
      false,
    );

    expect(input.commissionPercent).toBe(13);
    expect(input.commissionGstPercent).toBe(18);
  });

  it('prefers the direct link when an offer somehow has both', () => {
    const input = buildPayoutInputFromOrderItem(
      orderItem({
        catalogProduct: rates({ commissionPercent: 15 }),
        variant: { catalogProduct: rates({ commissionPercent: 13 }) },
      }),
      false,
    );

    expect(input.commissionPercent).toBe(15);
  });

  describe('the fallback chain', () => {
    it('prefers the product over its sub-category and category', () => {
      const input = buildPayoutInputFromOrderItem(
        orderItem({
          catalogProduct: rates({
            commissionPercent: 15,
            commissionGstPercent: 12,
            subCategory: { commissionPercent: 9, commissionGstPercent: 9 },
            category: { commissionPercent: 4, commissionGstPercent: 4 },
          }),
          variant: null,
        }),
        false,
      );

      expect(input.commissionPercent).toBe(15);
      expect(input.commissionGstPercent).toBe(12);
    });

    it('falls back to the sub-category when the product has no rate', () => {
      const input = buildPayoutInputFromOrderItem(
        orderItem({
          catalogProduct: rates({
            subCategory: { commissionPercent: 9, commissionGstPercent: 9 },
            category: { commissionPercent: 4, commissionGstPercent: 4 },
          }),
          variant: null,
        }),
        false,
      );

      expect(input.commissionPercent).toBe(9);
      expect(input.commissionGstPercent).toBe(9);
    });

    it('falls back to the category when neither product nor sub-category has one', () => {
      const input = buildPayoutInputFromOrderItem(
        orderItem({
          catalogProduct: rates({
            subCategory: {
              commissionPercent: null,
              commissionGstPercent: null,
            },
            category: { commissionPercent: 4, commissionGstPercent: 4 },
          }),
          variant: null,
        }),
        false,
      );

      expect(input.commissionPercent).toBe(4);
      expect(input.commissionGstPercent).toBe(4);
    });

    it('falls back to the offer last of all', () => {
      // No column backs this on SellerOffer today; the step is kept so an
      // offer-level override stays a one-line change, and pinned here so the
      // chain's ORDER is the thing under test.
      const input = buildPayoutInputFromOrderItem(
        orderItem({
          catalogProduct: rates(),
          variant: null,
          commissionPercent: 7,
          commissionGstPercent: 7,
        }),
        false,
      );

      expect(input.commissionPercent).toBe(7);
      expect(input.commissionGstPercent).toBe(7);
    });

    it('bottoms out at 0% commission but 18% GST when nothing is configured', () => {
      const input = buildPayoutInputFromOrderItem(
        orderItem({ catalogProduct: rates(), variant: null }),
        false,
      );

      expect(input.commissionPercent).toBe(0);
      // Never 0: an unconfigured GST rate is an omission, not an exemption.
      expect(input.commissionGstPercent).toBe(18);
    });

    it('resolves 0% in SILENCE when the offer was loaded without either link', () => {
      // The failure mode the required PayoutOfferSource keys exist to stop.
      // TypeScript rejects this shape now; the cast proves what the runtime
      // would still do if a half-loaded offer ever reached the engine, so the
      // guard is understood to be the only thing preventing it.
      const input = buildPayoutInputFromOrderItem(
        orderItem({}) as any,
        false,
      );

      expect(input.commissionPercent).toBe(0);
    });
  });

  it('takes the base price from the SNAPSHOTTED unitPrice, not the live mrp', () => {
    // A seller editing their listing must not re-price a past settlement.
    const input = buildPayoutInputFromOrderItem(
      {
        ...orderItem({
          catalogProduct: rates({ commissionPercent: 10 }),
          variant: null,
        }),
        unitPrice: 100,
        sellerOffer: {
          mrp: 999,
          finalShippingPrice: null,
          shippingCharges: null,
          catalogProduct: rates({ commissionPercent: 10 }),
          variant: null,
        },
      },
      false,
    );

    expect(input.baseSellingPrice).toBe(100);
  });

  it('prefers finalShippingPrice over the raw shippingCharges', () => {
    const input = buildPayoutInputFromOrderItem(
      orderItem({
        catalogProduct: rates(),
        variant: null,
        finalShippingPrice: 59,
        shippingCharges: 50,
      }),
      false,
    );

    expect(input.finalShippingPrice).toBe(59);
  });

  it('passes the order fulfilment flag straight through', () => {
    const offer = { catalogProduct: rates(), variant: null };

    expect(
      buildPayoutInputFromOrderItem(orderItem(offer), true).sellerKeepsShipping,
    ).toBe(true);
    expect(
      buildPayoutInputFromOrderItem(orderItem(offer), false).sellerKeepsShipping,
    ).toBe(false);
  });
});

describe('the two invoices from the bug report, end to end', () => {
  const rates = (pct: number, gst: number) => ({
    commissionPercent: pct,
    commissionGstPercent: gst,
    subCategory: null,
    category: null,
  });

  it('(a) ₹11 product + ₹6 shipping at 15%/18%, platform-shipped', () => {
    // Production invoiced "Marketplace commission at 4.97% … Rs. 0.84" with
    // IGST @ 0% — a flat 5% of the ₹17 total, and no GST at all.
    const breakdown = calculateSellerPayout(
      buildPayoutInputFromOrderItem(
        {
          id: 'i',
          sellerId: 's',
          unitPrice: 11,
          quantity: 1,
          sellerOffer: {
            finalShippingPrice: 6,
            shippingCharges: 6,
            catalogProduct: rates(15, 18),
            variant: null,
          },
        },
        false,
      ),
    );

    expect(breakdown.grossAmount.toFixed(2)).toBe('17.00');
    expect(breakdown.commission.toFixed(2)).toBe('1.65');
    expect(breakdown.commissionGst.toFixed(2)).toBe('0.30');
    expect(breakdown.netPayout.toFixed(2)).toBe('9.05');
  });

  it('(b) a ₹250 order at 13%/18%, no shipping', () => {
    // Production invoiced "at 5% … Rs. 12.50" with IGST @ 0%.
    const breakdown = calculateSellerPayout(
      buildPayoutInputFromOrderItem(
        {
          id: 'i',
          sellerId: 's',
          unitPrice: 250,
          quantity: 1,
          sellerOffer: {
            finalShippingPrice: 0,
            shippingCharges: 0,
            catalogProduct: null,
            variant: { catalogProduct: rates(13, 18) },
          },
        },
        false,
      ),
    );

    expect(breakdown.grossAmount.toFixed(2)).toBe('250.00');
    expect(breakdown.commission.toFixed(2)).toBe('32.50');
    expect(breakdown.commissionGst.toFixed(2)).toBe('5.85');
    expect(breakdown.netPayout.toFixed(2)).toBe('211.65');
  });
});
