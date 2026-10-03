import { Prisma } from '@prisma/client';
import {
  FULFILLMENT_MODE_SELF_SHIP,
  FULFILLMENT_MODE_SHIPROCKET,
  buyerShipping,
  isSelfShipOrder,
  resolveOfferShipping,
} from './shipping.util';

/**
 * The numbers are the ones from the bug report: a ₹90 catalogue shipping charge
 * plus 18% shipping GST = ₹106.20, which both listings of the same master
 * product had inherited.
 */
const CATALOGUE = {
  shippingCharges: new Prisma.Decimal('90'),
  finalShippingPrice: new Prisma.Decimal('106.2'),
  shippingGstPercent: new Prisma.Decimal('18'),
  isTaxIncluded: false,
};

const SELLERS_OWN = { shippingCharges: 150, finalShippingPrice: 150 };

describe('resolveOfferShipping', () => {
  it("imposes the catalogue's charge when Yukizi does the shipping", () => {
    expect(resolveOfferShipping(SELLERS_OWN, CATALOGUE, false)).toEqual({
      shippingCharges: 90,
      finalShippingPrice: 106.2,
    });
  });

  it('keeps what the seller submitted when they ship it themselves', () => {
    expect(resolveOfferShipping(SELLERS_OWN, CATALOGUE, true)).toEqual(
      SELLERS_OWN,
    );
  });

  // Free delivery is a real choice, and 0 must survive — the whole complaint
  // was the catalogue charge coming back over a figure the seller had set.
  it('keeps a self-shipping seller at zero', () => {
    const free = { shippingCharges: 0, finalShippingPrice: 0 };
    expect(resolveOfferShipping(free, CATALOGUE, true)).toEqual(free);
  });

  it('leaves an orphan listing alone — there is no catalogue figure to impose', () => {
    expect(resolveOfferShipping(SELLERS_OWN, null, false)).toEqual(SELLERS_OWN);
  });

  it('derives the GST-inclusive figure for a master that predates the field', () => {
    expect(
      resolveOfferShipping(
        SELLERS_OWN,
        { ...CATALOGUE, finalShippingPrice: null },
        false,
      ),
    ).toEqual({ shippingCharges: 90, finalShippingPrice: 106.2 });
  });

  it('does not re-add GST to a tax-inclusive master', () => {
    expect(
      resolveOfferShipping(
        SELLERS_OWN,
        { ...CATALOGUE, finalShippingPrice: null, isTaxIncluded: true },
        false,
      ),
    ).toEqual({ shippingCharges: 90, finalShippingPrice: 90 });
  });

  it('carries a free-shipping catalogue product through as zero', () => {
    expect(
      resolveOfferShipping(
        SELLERS_OWN,
        { shippingCharges: 0, finalShippingPrice: 0 },
        false,
      ),
    ).toEqual({ shippingCharges: 0, finalShippingPrice: 0 });
  });
});

describe('buyerShipping', () => {
  it('prefers the final, GST-inclusive figure', () => {
    expect(
      buyerShipping({
        finalShippingPrice: new Prisma.Decimal('106.2'),
        shippingCharges: new Prisma.Decimal('90'),
      }),
    ).toBe(106.2);
  });

  it('falls back to the raw charge when no final price was stored', () => {
    expect(buyerShipping({ shippingCharges: new Prisma.Decimal('90') })).toBe(90);
  });

  it('treats an explicit zero as zero, not as missing', () => {
    expect(
      buyerShipping({
        finalShippingPrice: new Prisma.Decimal(0),
        shippingCharges: new Prisma.Decimal('90'),
      }),
    ).toBe(0);
  });

  it('is zero for an offer that carries no shipping at all', () => {
    expect(buyerShipping({})).toBe(0);
    expect(buyerShipping(null)).toBe(0);
  });
});

describe('isSelfShipOrder', () => {
  it('reads the order snapshot, not the seller flag', () => {
    expect(isSelfShipOrder({ fulfillmentMode: FULFILLMENT_MODE_SELF_SHIP })).toBe(
      true,
    );
    expect(
      isSelfShipOrder({ fulfillmentMode: FULFILLMENT_MODE_SHIPROCKET }),
    ).toBe(false);
  });

  // Orders predating the self-ship feature have no snapshot at all; they were
  // all platform-shipped.
  it('treats a missing snapshot as platform-shipped', () => {
    expect(isSelfShipOrder({ fulfillmentMode: null })).toBe(false);
    expect(isSelfShipOrder({})).toBe(false);
    expect(isSelfShipOrder(null)).toBe(false);
  });
});
