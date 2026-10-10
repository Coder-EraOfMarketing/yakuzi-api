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
/**
 * Loading a row with Prisma `select`? Name `preOrderDeliveryDate` explicitly.
 * An omitted key and a `null` value both arrive here as `undefined` —
 * `isPreOrder` cannot tell "not a pre-order" apart from "nobody asked for the
 * column" and will quietly answer `false` either way. A pre-order listing
 * fetched through a narrow `select` that forgot this field will get its
 * stock decremented and restocked like ordinary inventory, with no error to
 * surface the mistake.
 */
export interface PreOrderable {
  preOrderDeliveryDate?: Date | string | null;
}

export function isPreOrder(offer: PreOrderable | null | undefined): boolean {
  return offer?.preOrderDeliveryDate != null;
}
