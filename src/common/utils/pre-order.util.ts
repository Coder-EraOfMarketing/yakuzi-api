/**
 * Loading a row with Prisma `select`? Name `preOrderDeliveryDate` explicitly.
 *
 * A column nobody asked for is absent, and `isPreOrder` reads an absent key
 * exactly as it reads a stored `null` — both mean "no date", so it quietly
 * answers `false`. There is no error and no type complaint to catch the
 * mistake. A pre-order listing fetched through a narrow `select` that forgot
 * this field will therefore have its stock decremented and restocked like
 * ordinary inventory.
 *
 * Every narrow `select` that loads an offer has to name this column, and
 * there are several. Deliberately not listed here: a list in a comment goes
 * stale the moment someone adds a gate, and a stale list is worse than none
 * because it reads as permission to skip the check. `grep -rn
 * "preOrderDeliveryDate" src` is the honest answer.
 *
 * `products.findOwnProduct` is the inverse trap: it deliberately runs a bare
 * `findFirst` with no `select` at all. `update()`'s guard falls back to the
 * stored row whenever an edit omits `preOrderDeliveryDate`, so narrowing that
 * query — an entirely ordinary optimisation — would make every partial edit
 * of a pre-order look like an ordinary listing and write its stock away.
 */
export interface PreOrderable {
  preOrderDeliveryDate?: Date | string | null;
}

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
export function isPreOrder(offer: PreOrderable | null | undefined): boolean {
  // Loose `!= null` on purpose: it catches both a stored null and an absent
  // key in one comparison. See the note on PreOrderable about the latter.
  return offer?.preOrderDeliveryDate != null;
}

/**
 * The submitted date, ready for Prisma.
 *
 * The wire carries a string and the column is a DateTime, so every write path
 * has to coerce. Doing it here keeps the five persist sites from each picking
 * their own answer for what an absent date means — it is `null`, which clears
 * the column and so turns pre-order off.
 */
export function toPreOrderDate(src: PreOrderable): Date | null {
  return src.preOrderDeliveryDate ? new Date(src.preOrderDeliveryDate) : null;
}
