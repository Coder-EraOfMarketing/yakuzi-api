import Decimal from 'decimal.js';
import { Prisma } from '@prisma/client';
import { buyerShipping } from '../../common/utils/shipping.util';

/** The two rates, wherever on the taxonomy they happen to be configured. */
const commissionRateSelect = Prisma.validator<Prisma.CatalogProductSelect>()({
  id: true,
  name: true,
  commissionPercent: true,
  commissionGstPercent: true,
  subCategory: { select: { commissionPercent: true, commissionGstPercent: true } },
  category: { select: { commissionPercent: true, commissionGstPercent: true } },
});

/**
 * The ONE query shape that loads everything buildPayoutInputFromOrderItem's
 * resolution chain reads. Spread this into any order-item query whose result
 * is handed to the payout engine.
 *
 * It exists because a correct resolution chain is useless if the query never
 * fetched the fields, and that failure is SILENT — a missing include resolves
 * to a 0% commission rather than an error. In particular an offer reaches its
 * catalogue product TWO ways: SellerOffer.catalogProductId directly, or
 * variantId -> ProductVariant.catalogProductId. Following only the variant
 * link silently gets nothing for a directly-linked offer, which is how
 * sellers came to be charged 0% GST and a 5% flat commission.
 */
export const payoutOfferSelect = Prisma.validator<Prisma.SellerOfferSelect>()({
  id: true,
  name: true,
  mrp: true,
  finalShippingPrice: true,
  shippingCharges: true,
  catalogProduct: { select: commissionRateSelect },
  variant: { select: { catalogProduct: { select: commissionRateSelect } } },
});

/** `include` for an order item that is about to be settled or estimated. */
export const payoutOrderItemInclude = Prisma.validator<Prisma.OrderItemInclude>()({
  sellerOffer: { select: payoutOfferSelect },
});

type Rate = Prisma.Decimal | number | null;

/** Commission config as it sits on a catalogue product, or on its taxonomy. */
export interface PayoutRateSource {
  commissionPercent?: Rate;
  commissionGstPercent?: Rate;
  subCategory?: { commissionPercent?: Rate; commissionGstPercent?: Rate } | null;
  category?: { commissionPercent?: Rate; commissionGstPercent?: Rate } | null;
}

/**
 * An offer loaded by payoutOfferSelect.
 *
 * `catalogProduct` and `variant` are deliberately REQUIRED (though nullable):
 * an offer reaches its catalogue product either directly or through its
 * variant, and a caller that fetched only one of the two must fail to compile
 * rather than silently settle at 0%. Null means "loaded, and genuinely not
 * linked that way"; omitted means "never fetched", which is the bug.
 */
export interface PayoutOfferSource {
  finalShippingPrice?: Rate;
  shippingCharges?: Rate;
  mrp?: Prisma.Decimal | number;
  catalogProduct: PayoutRateSource | null;
  variant: { catalogProduct: PayoutRateSource | null } | null;
}

/** An order item carrying everything the payout engine needs. */
export interface PayoutOrderItemSource {
  id: string;
  sellerId: string;
  unitPrice: Prisma.Decimal | number;
  quantity: number;
  sellerOffer?: PayoutOfferSource | null;
}

/**
 * All monetary inputs and outputs use Decimal for precision.
 * Rates are in percentage form (e.g., 10 = 10%).
 */
export interface PayoutInput {
  /** From SellerOffer.mrp minus discounts, already calculated */
  baseSellingPrice: number;
  /** From OrderItem.quantity */
  quantity: number;
  /** From SellerOffer.finalShippingPrice ?? SellerOffer.shippingCharges */
  finalShippingPrice: number;
  /** From CatalogProduct.commissionPercent ?? 0 */
  commissionPercent: number;
  /** From CatalogProduct.commissionGstPercent ?? 18 */
  commissionGstPercent: number;
  /**
   * True when the SELLER booked the courier for this order (Order.fulfillmentMode
   * === 'self_ship'), so the shipping the buyer paid belongs to them and the
   * platform does not withhold it. Defaults to false, i.e. the platform-shipped
   * behaviour of withholding it.
   *
   * It does NOT affect the commission base: shipping is excluded from that
   * either way (see calculateSellerPayout step 2).
   */
  sellerKeepsShipping?: boolean;
}

export interface PayoutBreakdown {
  grossAmount: Decimal;
  /**
   * The base the commission was charged on — the product subtotal, with
   * shipping excluded. Returned, and persisted on the settlement, because
   * grossAmount includes shipping and so cannot be used to recover the rate:
   * commission/grossAmount prints 9.71% for a configured 15% on a ₹11 + ₹6
   * order. Anything that needs to state the rate divides by THIS.
   */
  commissionableAmount: Decimal;
  commission: Decimal;
  commissionGst: Decimal;
  /**
   * The shipping WITHHELD from the seller — what the order breakdowns render as
   * "Shipping (Deducted)". Zero on a self-ship order, where the seller keeps it;
   * read buyerPaidShipping for what the buyer was charged either way.
   */
  finalShippingPrice: Decimal;
  /** What the buyer paid for shipping, whoever ends up with it. */
  buyerPaidShipping: Decimal;
  totalDeductions: Decimal;
  netPayout: Decimal;
  /** PENDING | DEFICIT_ESCALATED */
  status: string;
}

/**
 * Core payout calculation engine.
 *
 * Mathematical flow:
 *  1. Gross Order Amount = (Base Selling Price × Qty) + finalShippingPrice
 *  2. Platform Commission = (Base Selling Price × Qty) × commissionPercent
 *  3. GST on Commission   = Commission × commissionGstPercent
 *  4. Net Seller Payout   = Gross - (Commission + CommGST + withheld shipping)
 *
 * Shipping is excluded from the commission base at step 2 ALWAYS, whoever
 * booked the courier: the platform's cut is earned on the product, never on a
 * courier bill it merely passed through. This is also what the seller-facing
 * estimate modal has always shown, so the two now agree; before this they
 * differed by commissionPercent × shipping on every platform-shipped order.
 *
 * Fulfilment mode decides one thing only — whether shipping is WITHHELD at
 * step 4. It stays in the gross either way, because the buyer really did pay
 * it. Platform-shipped: the platform booked the courier, so it withholds it.
 * SELF-SHIP: the seller booked the courier, so the money is theirs and
 * nothing is withheld.
 */
export function calculateSellerPayout(input: PayoutInput): PayoutBreakdown {
  Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

  const qty = new Decimal(input.quantity);
  const basePrice = new Decimal(input.baseSellingPrice);
  const shipping = new Decimal(input.finalShippingPrice ?? 0);
  const sellerKeepsShipping = input.sellerKeepsShipping === true;

  // Step 1: Gross Order Amount = Base Item Price + Final Shipping Price
  const grossAmount = basePrice.times(qty).plus(shipping).toDecimalPlaces(2);

  // Step 2: Platform Commission = Commissionable Amount * Commission Rate.
  // The commissionable amount is the PRODUCT subtotal — shipping is never part
  // of it, whoever booked the courier. Not conditional on sellerKeepsShipping:
  // that flag governs withholding at step 4, nothing here.
  // Rounded to 2dp because it is persisted as DECIMAL(10,2) and then divided
  // into the commission to state the rate; an unrounded base would print a
  // rate that disagreed with the stored column.
  const commissionableAmount = grossAmount.minus(shipping).toDecimalPlaces(2);
  const commissionRate = new Decimal(input.commissionPercent ?? 0).dividedBy(100);
  const commission = commissionableAmount.times(commissionRate).toDecimalPlaces(2);

  // Step 3: GST on Commission = Commission * Commission GST Rate
  const commissionGstRate = new Decimal(input.commissionGstPercent ?? 18).dividedBy(100);
  const commissionGst = commission.times(commissionGstRate).toDecimalPlaces(2);

  // Step 4: Net Seller Payout = Gross - (Commission + GST on Commission + withheld shipping)
  const withheldShipping = sellerKeepsShipping ? new Decimal(0) : shipping;
  const totalDeductions = commission
    .plus(commissionGst)
    .plus(withheldShipping);

  const rawNetPayout = grossAmount.minus(totalDeductions);

  const isDeficit = rawNetPayout.lessThan(0);
  const netPayout = isDeficit ? new Decimal(0) : rawNetPayout.toDecimalPlaces(2);

  return {
    grossAmount,
    commissionableAmount,
    commission,
    commissionGst,
    finalShippingPrice: withheldShipping,
    buyerPaidShipping: shipping,
    totalDeductions: totalDeductions.toDecimalPlaces(2),
    netPayout,
    status: isDeficit ? 'DEFICIT_ESCALATED' : 'PENDING',
  };
}

/**
 * Helper to build PayoutInput from an OrderItem and its nested relations.
 * Requires orderItem.sellerOffer and orderItem.catalogProduct to be populated.
 *
 * `fulfilledBySeller` is deliberately a required argument rather than something
 * read off the seller profile: it must come from the ORDER's fulfillmentMode,
 * snapshotted at checkout. Reading the seller's live selfShipEnabled flag here
 * would re-price every past settlement the moment an admin touched the Self
 * Ship toggle. Callers get it from isSelfShipOrder(item.order).
 */
export function buildPayoutInputFromOrderItem(
  orderItem: any,
  fulfilledBySeller: boolean,
): PayoutInput {
  const offer = orderItem.sellerOffer || {};
  const product = orderItem.catalogProduct || offer.catalogProduct || offer.variant?.catalogProduct || {};

  // OrderItem.unitPrice is the price SNAPSHOTTED at checkout and is the only
  // figure a settlement may be built from — offer.mrp is live, so reading it
  // would re-price every past order the moment the seller edited the listing.
  // (`price` is not a column on OrderItem; it is kept for callers that hand in
  // a synthesised item, and offer.mrp is the last resort for an item loaded
  // without its price.)
  const baseSellingPrice =
    orderItem.unitPrice ??
    orderItem.price ??
    (offer.mrp ? offer.mrp - (offer.discount || 0) : 0);

  return {
    baseSellingPrice: Number(baseSellingPrice),
    quantity: Number(orderItem.quantity || 1),
    finalShippingPrice: buyerShipping(offer),
    sellerKeepsShipping: fulfilledBySeller,
    commissionPercent: Number(
      product.commissionPercent ??
      product.subCategory?.commissionPercent ??
      product.category?.commissionPercent ??
      offer.commissionPercent ??
      0
    ),
    commissionGstPercent: Number(
      product.commissionGstPercent ??
      product.subCategory?.commissionGstPercent ??
      product.category?.commissionGstPercent ??
      offer.commissionGstPercent ??
      18
    ),
  };
}

