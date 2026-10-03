/**
 * Order.fulfillmentMode values. Snapshotted from the seller's selfShipEnabled
 * flag at checkout; the two flows are mutually exclusive per order.
 *
 * They live here rather than in OrdersService because the payout calculator and
 * the settlement paths need them too, and importing a service into a pure
 * calculator is how import cycles start.
 */
export const FULFILLMENT_MODE_SHIPROCKET = 'shiprocket';
export const FULFILLMENT_MODE_SELF_SHIP = 'self_ship';

/** Whether this order was placed against a self-shipping seller. */
export function isSelfShipOrder(
  order: { fulfillmentMode?: string | null } | null | undefined,
): boolean {
  return order?.fulfillmentMode === FULFILLMENT_MODE_SELF_SHIP;
}

/** Round to 2dp the same way the pricing engine does. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface OfferShipping {
  /** The charge itself. Excludes shipping GST unless isTaxIncluded. */
  shippingCharges: number;
  /** The GST-inclusive figure the buyer is actually charged. */
  finalShippingPrice: number;
}

interface CatalogueShippingSource {
  shippingCharges?: unknown;
  finalShippingPrice?: unknown;
  shippingGstPercent?: unknown;
  isTaxIncluded?: boolean | null;
}

/**
 * Who sets a listing's shipping charge, and therefore what gets stored on it.
 *
 * Shipping on Yukizi has two régimes, decided by SellerProfile.selfShipEnabled:
 *
 *  - SELF SHIP OFF — Yukizi books the courier, so Yukizi's number is the one
 *    that counts. The listing inherits the catalogue product's shipping no
 *    matter what the form submitted, which is what keeps every listing of a
 *    product shipping at the same rate.
 *  - SELF SHIP ON — the seller books their own courier and names their own
 *    price, including zero. Whatever they submitted is kept verbatim.
 *
 * A listing with no master product (an orphan) has no catalogue figure to
 * inherit, so the submitted value stands in both régimes.
 *
 * This decides the AMOUNT ONLY. Who ends up with the money is a separate
 * question answered by calculateSellerPayout: the platform withholds shipping
 * when it did the shipping, and leaves it with the seller when they did.
 */
export function resolveOfferShipping(
  submitted: OfferShipping,
  master: CatalogueShippingSource | null | undefined,
  sellerSelfShips: boolean,
): OfferShipping {
  if (sellerSelfShips || !master) return submitted;

  const charges = Number(master.shippingCharges ?? 0) || 0;
  // The catalogue form stores finalShippingPrice alongside the raw charge;
  // derive it only when the master predates that field.
  if (master.finalShippingPrice !== null && master.finalShippingPrice !== undefined) {
    return {
      shippingCharges: charges,
      finalShippingPrice: Number(master.finalShippingPrice) || 0,
    };
  }
  const gstPercent = Number(master.shippingGstPercent ?? 18) || 0;
  return {
    shippingCharges: charges,
    finalShippingPrice: master.isTaxIncluded
      ? charges
      : round2(charges * (1 + gstPercent / 100)),
  };
}

/** What a buyer is charged to have one unit of a listing delivered. */
export function buyerShipping(
  offer: { finalShippingPrice?: unknown; shippingCharges?: unknown } | null | undefined,
): number {
  const raw = offer?.finalShippingPrice ?? offer?.shippingCharges ?? 0;
  return Number(raw) || 0;
}
