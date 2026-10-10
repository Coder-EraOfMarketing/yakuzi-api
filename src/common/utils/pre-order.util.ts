/**
 * Loading a row with Prisma `select`? Name `preOrderDeliveryDate` explicitly.
 *
 * A column nobody asked for is absent, and `isPreOrder` reads an absent key
 * exactly as it reads a stored `null` — both mean "no date", so it answers
 * `false`. A pre-order listing fetched through a narrow `select` that forgot
 * this field would therefore have its stock decremented and restocked like
 * ordinary inventory.
 *
 * How much the compiler saves you depends on the row's type, and it is worth
 * knowing which case you are in:
 *
 *   - a **typed** Prisma payload from a narrow `select` fails to compile. The
 *     only member of `PreOrderable` is optional, so a row lacking the key has
 *     no properties in common with it and weak-type detection rejects the
 *     call — TS2559. That mistake is caught at build time, not in production.
 *   - an **`any`** row, or a response object built by hand, gets no such help.
 *     This is where the real exposure lives: `orders.getOrderDetail` maps its
 *     items as `(item: any)`, and `orders.getSellerOrders` assembles its
 *     response from an explicit field list, where a column being present on
 *     the row does not put it on the wire. Both have to name this field
 *     deliberately.
 *
 * So: narrow a typed query and the build will tell you. Reach for the column
 * through an `any`, or forward it into a payload you are constructing by hand,
 * and nothing will.
 *
 * Which queries those are is deliberately not listed here: a list in a comment
 * goes stale the moment someone adds a gate, and a stale list is worse than
 * none because it reads as permission to skip the check. `grep -rn
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
