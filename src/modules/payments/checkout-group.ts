/**
 * Which orders one payment covers.
 *
 * Checkout splits a cart into one order per seller — three sellers, three
 * orders — but the buyer pays once, for the basket. Everything that takes or
 * confirms money therefore has to work on the whole group, not on whichever
 * order happened to come first.
 *
 * Orders placed from this release carry a `checkoutGroupId`, which says exactly
 * which orders one checkout produced. Orders placed before it have NULL, so
 * they fall back to the rule the payment code used until now: same buyer,
 * created within five seconds. That fallback is a guess — two carts placed from
 * two tabs in the same second look like one group to it — which is why new
 * orders no longer rely on it.
 */

/** How far apart two orders may be created and still be treated as one cart. */
export const LEGACY_GROUP_WINDOW_MS = 5000;

export type GroupAnchor = {
  buyerId: string;
  createdAt: Date;
  checkoutGroupId?: string | null;
};

/**
 * A Prisma `where` that selects every order in the same checkout as `anchor`,
 * including the anchor itself.
 */
export function checkoutGroupWhere(anchor: GroupAnchor) {
  if (anchor.checkoutGroupId) {
    return { checkoutGroupId: anchor.checkoutGroupId };
  }

  const at = anchor.createdAt.getTime();
  return {
    buyerId: anchor.buyerId,
    createdAt: {
      gte: new Date(at - LEGACY_GROUP_WINDOW_MS),
      lte: new Date(at + LEGACY_GROUP_WINDOW_MS),
    },
    // A pre-migration order must not be swept into a group with orders placed
    // after the column existed: those already have an id of their own, and
    // matching them here would charge one cart's payment against another's.
    checkoutGroupId: null,
  };
}
