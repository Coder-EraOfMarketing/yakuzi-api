/**
 * Abandoned-checkout grouping and summarising. Pure, so the rules that are easy
 * to get subtly wrong can be tested without a database.
 *
 * What "abandoned" means here (decided with the owner, see the admin tab):
 * a checkout that reached the payment step and never completed it. Concretely
 * an Order with sellersNotifiedAt IS NULL that is unpaid and either still
 * PLACED ("in progress") or CANCELLED ("abandoned"). The query lives in
 * AdminService.getAbandonedCheckouts; this file only shapes what it returns.
 */

/**
 * sellersNotifiedAt arrived in migration 20260819110000_defer_seller_notification
 * with NO backfill, so every order created before it has a null value whatever
 * its payment method. Counting those would present years of ordinary cancelled
 * orders as abandoned checkouts. Orders before this instant cannot be
 * classified, so they are excluded rather than guessed at.
 */
export const ABANDONMENT_TRACKING_START = new Date('2026-08-19T11:00:00.000Z');

/** Hard ceiling on rows pulled for in-memory grouping. See getAbandonedCheckouts. */
export const ABANDONED_ROW_CAP = 5000;

export type AbandonedState = 'abandoned' | 'in_progress';

export interface AbandonedOrderRow {
  id: string;
  buyerId: string;
  checkoutGroupId: string | null;
  orderStatus: string;
  totalAmount: number;
  createdAt: Date;
  cancelledAt: Date | null;
  cancellationReason: string | null;
}

export interface AbandonedCheckout {
  /** checkoutGroupId, or the order id for an order that predates grouping. */
  key: string;
  state: AbandonedState;
  buyerId: string;
  orderIds: string[];
  startedAt: Date;
  cancelledAt: Date | null;
  cancellationReason: string | null;
  totalAmount: number;
}

export interface AbandonedSummary {
  abandonedCount: number;
  abandonedValue: number;
  inProgressCount: number;
  inProgressValue: number;
}

const money = (n: number): number => Math.round(n * 100) / 100;

/**
 * One abandoned CHECKOUT, not one abandoned order.
 *
 * checkout() splits a basket into one Order per seller, all sharing a
 * checkoutGroupId, and the buyer pays once for the lot. Listing orders as they
 * come would report a single abandoned three-seller basket as three
 * abandonments and triple-count its value.
 *
 * A group still containing any PLACED order is in progress: the sweep cancels
 * orders one at a time, so for a moment a group can be part cancelled and
 * calling it abandoned early would invite someone to chase a buyer the sweep is
 * still emailing.
 */
export function groupAbandonedCheckouts(rows: AbandonedOrderRow[]): AbandonedCheckout[] {
  const groups = new Map<string, AbandonedOrderRow[]>();
  for (const row of rows) {
    const key = row.checkoutGroupId ?? row.id;
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }

  const out: AbandonedCheckout[] = [];
  for (const [key, members] of groups) {
    const stillPlaced = members.some((m) => m.orderStatus === 'PLACED');
    const cancelTimes = members
      .map((m) => m.cancelledAt)
      .filter((d): d is Date => d instanceof Date);
    out.push({
      key,
      state: stillPlaced ? 'in_progress' : 'abandoned',
      buyerId: members[0].buyerId,
      orderIds: members.map((m) => m.id),
      startedAt: new Date(Math.min(...members.map((m) => m.createdAt.getTime()))),
      cancelledAt: cancelTimes.length
        ? new Date(Math.max(...cancelTimes.map((d) => d.getTime())))
        : null,
      cancellationReason: members.find((m) => m.cancellationReason)?.cancellationReason ?? null,
      totalAmount: money(members.reduce((sum, m) => sum + m.totalAmount, 0)),
    });
  }

  return out.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
}

export function summariseAbandoned(groups: AbandonedCheckout[]): AbandonedSummary {
  const s: AbandonedSummary = {
    abandonedCount: 0,
    abandonedValue: 0,
    inProgressCount: 0,
    inProgressValue: 0,
  };
  for (const g of groups) {
    if (g.state === 'abandoned') {
      s.abandonedCount += 1;
      s.abandonedValue += g.totalAmount;
    } else {
      s.inProgressCount += 1;
      s.inProgressValue += g.totalAmount;
    }
  }
  s.abandonedValue = money(s.abandonedValue);
  s.inProgressValue = money(s.inProgressValue);
  return s;
}

/**
 * Did this buyer complete a purchase after abandoning? Chasing someone who has
 * since bought is wasted effort, and counting them as lost revenue overstates
 * the loss, so the screen flags it.
 *
 * `purchases` are the buyer's orders that were genuinely placed (sellers
 * notified, not cancelled) — by construction never part of an abandoned group.
 * Strictly later: a purchase created in the same instant is the same checkout.
 */
export function boughtLater(
  group: Pick<AbandonedCheckout, 'buyerId' | 'startedAt'>,
  purchases: { buyerId: string; createdAt: Date }[],
): boolean {
  return purchases.some(
    (p) => p.buyerId === group.buyerId && p.createdAt.getTime() > group.startedAt.getTime(),
  );
}
