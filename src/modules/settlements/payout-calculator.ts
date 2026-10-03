import Decimal from 'decimal.js';
import { buyerShipping } from '../../common/utils/shipping.util';

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
   * platform neither withholds it nor earns commission on it. Defaults to false,
   * i.e. the platform-shipped behaviour this engine has always had.
   */
  sellerKeepsShipping?: boolean;
}

export interface PayoutBreakdown {
  grossAmount: Decimal;
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
 * Mathematical flow (platform-shipped):
 *  1. Gross Order Amount = (Base Selling Price × Qty) + finalShippingPrice
 *  2. Platform Commission = Gross × commissionPercent
 *  3. GST on Commission   = Commission × commissionGstPercent
 *  4. Net Seller Payout   = Gross - (Commission + CommGST + finalShippingPrice)
 *
 * On a SELF-SHIP order the seller booked the courier, so the shipping the buyer
 * paid is theirs: it stays in the gross (the buyer really did pay it), it is not
 * withheld at step 4, and it is excluded from the commission base at step 2 —
 * the platform's cut is earned on the product, not on the seller's courier bill.
 */
export function calculateSellerPayout(input: PayoutInput): PayoutBreakdown {
  Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

  const qty = new Decimal(input.quantity);
  const basePrice = new Decimal(input.baseSellingPrice);
  const shipping = new Decimal(input.finalShippingPrice ?? 0);
  const sellerKeepsShipping = input.sellerKeepsShipping === true;

  // Step 1: Gross Order Amount = Base Item Price + Final Shipping Price
  const grossAmount = basePrice.times(qty).plus(shipping).toDecimalPlaces(2);

  // Step 2: Platform Commission = Commissionable Amount * Commission Rate
  const commissionableAmount = sellerKeepsShipping
    ? grossAmount.minus(shipping)
    : grossAmount;
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

  // For base selling price, orderItem.price might be the exact selling price at the time of order.
  // If not present, fallback to mrp - discount
  const baseSellingPrice =
    orderItem.price ?? (offer.mrp ? offer.mrp - (offer.discount || 0) : 0);

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

