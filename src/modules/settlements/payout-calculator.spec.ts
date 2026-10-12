import { calculateSellerPayout, PayoutInput } from './payout-calculator';

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
    // Commission = 500 × 10% = 50   <- the PRODUCT subtotal, not the gross
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

  // The rule the two tests above and below now encode, stated once so a
  // future reader does not "restore" the old numbers: commission is charged
  // on the product subtotal only, never on shipping, whoever booked the
  // courier. Shipping still sits in the gross — the buyer really did pay it —
  // and is still withheld at step 4 on a platform-shipped order. Before this
  // the engine charged commission on the gross, so it disagreed with the
  // seller-facing estimate modal by commissionPercent × shipping on every
  // platform-shipped order; the modal was the one the business considered
  // correct.
  it('never charges commission on shipping, platform-shipped or not', () => {
    const platform = calculateSellerPayout(input({ sellerKeepsShipping: false }));
    const selfShip = calculateSellerPayout(input({ sellerKeepsShipping: true }));

    // 500 × 10%, identical either way — fulfilment mode governs WITHHOLDING,
    // not the commission base.
    expect(platform.commission.toFixed(2)).toBe('50.00');
    expect(selfShip.commission.toFixed(2)).toBe('50.00');

    // Shipping is in the gross for both, withheld only for platform-shipped.
    expect(platform.grossAmount.toFixed(2)).toBe('550.00');
    expect(selfShip.grossAmount.toFixed(2)).toBe('550.00');
    expect(platform.finalShippingPrice.toFixed(2)).toBe('50.00');
    expect(selfShip.finalShippingPrice.toFixed(2)).toBe('0.00');
  });

  // The real invoice that exposed the bug: a 15%/18% product sold at ₹11 with
  // ₹6 shipping, platform-shipped, was billed a flat 5% and no GST at all.
  it('reproduces the reported order at the configured rates', () => {
    const result = calculateSellerPayout(
      input({ baseSellingPrice: 11, quantity: 1, finalShippingPrice: 6, commissionPercent: 15 }),
    );

    expect(result.grossAmount.toFixed(2)).toBe('17.00');
    expect(result.commission.toFixed(2)).toBe('1.65'); // 15% of 11, not of 17
    expect(result.commissionGst.toFixed(2)).toBe('0.30'); // 18% of 1.65, not 0
    expect(result.netPayout.toFixed(2)).toBe('9.05'); // 17 - 1.65 - 0.30 - 6
  });

  // Test 2: Multi-Quantity Order
  it('should scale gross correctly for multi-quantity orders', () => {
    // Gross = (200 × 3) + 30 = 630
    // Commission = (200 × 3) × 5% = 30.00   <- product subtotal, shipping out
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
    expect(result.commissionGst.toFixed(2)).toBe('5.40');
    expect(result.netPayout.toFixed(2)).toBe('564.60');
    expect(result.status).toBe('PENDING');
  });

  // Test 3: Deficit / Zero-Payout Safety
  it('should set status to DEFICIT_ESCALATED and clamp payout to 0 when fees exceed gross', () => {
    // Very low price, high commission, high shipping => deficit
    // Gross = (10 × 1) + 50 = 60
    // Commission = 60 × 95% = 57
    // CommissionGST = 57 × 18% = 10.26
    // Total Deductions = 57 + 10.26 + 50 = 117.26
    // Net Payout (raw) = 60 - 117.26 = -57.26 → clamped to 0

    const result = calculateSellerPayout(
      input({
        baseSellingPrice: 10,
        quantity: 1,
        finalShippingPrice: 50,
        commissionPercent: 95,
      }),
    );

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

    it('leaves the seller better off than the same platform-shipped order', () => {
      const platform = calculateSellerPayout({
        ...selfShip,
        sellerKeepsShipping: false,
      });
      const seller = calculateSellerPayout(selfShip);

      // The gap is now EXACTLY the withheld shipping, nothing more.
      // Commission is 15% of the ₹1600 product subtotal either way, so
      // fulfilment mode no longer drags commission and GST along with it.
      // (It used to: platform-shipped charged 15% of the ₹1750 gross, making
      // the gap 150 + 22.50 + 4.05 = 176.55.)
      expect(platform.netPayout.toFixed(2)).toBe('1316.80');
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
});
