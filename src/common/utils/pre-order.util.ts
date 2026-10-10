/**
 * Is this listing sold as a pre-order?
 *
 * One definition, used by every stock gate, so "pre-order" cannot come to
 * mean slightly different things in the cart and at checkout.
 *
 * A pre-order listing has no tracked stock at all: quantity is unlimited and
 * nothing is reserved or decremented. The date is a promise shown to the
 * buyer and snapshotted onto the order, nothing more — a date in the past
 * still means pre-order, because nothing takes a listing down automatically.
 */
export interface PreOrderable {
  preOrderDeliveryDate?: Date | string | null;
}

export function isPreOrder(offer: PreOrderable | null | undefined): boolean {
  return offer?.preOrderDeliveryDate != null;
}
