import { ABANDONMENT_TRACKING_START } from './abandoned-checkouts.util';

/**
 * What an admin should read in the "Payment" column.
 *
 * Order.paymentStatus only ever says PENDING / SUCCESS / PARTIAL / FAILED, and
 * cancelling an unpaid order never changes it. So a buyer who pressed Pay,
 * closed the Razorpay popup and was auto-cancelled half an hour later showed
 * "PENDING" indefinitely, next to a cancelled order that was never going to be
 * paid. This derives the honest label without touching the stored status (the
 * payment, settlement and refund logic all read paymentStatus as it is).
 *
 * The signal is the same one the Abandoned checkouts tab uses: a Razorpay
 * checkout creates its Order with sellersNotifiedAt null and only stamps it
 * once payment succeeds. Anything else that is unpaid (bank transfer / UPI /
 * COD, all removed from the storefront but present on old orders) keeps its
 * stored status — "pending" is accurate for those, an admin confirms them by hand.
 *
 * There is deliberately no "abandoned at checkout" state: no Order exists until
 * the buyer presses Pay, so someone who leaves the checkout page earlier is not
 * an order at all.
 */
export type PaymentState =
  | 'AWAITING_PAYMENT'
  | 'ABANDONED_AT_PAYMENT'
  | 'PENDING'
  | 'SUCCESS'
  | 'PARTIAL'
  | 'FAILED';

export interface PaymentStateInput {
  paymentStatus: string;
  orderStatus: string;
  /** Must be selected: undefined is "unknown", not "null", and is never guessed at. */
  sellersNotifiedAt?: Date | null;
  createdAt: Date;
}

export function derivePaymentState(order: PaymentStateInput): PaymentState {
  const stored = order.paymentStatus as PaymentState;

  if (stored !== 'PENDING' && stored !== 'FAILED') return stored;

  // sellersNotifiedAt has no backfill before this instant, so a null there
  // says nothing about the payment method.
  if (order.sellersNotifiedAt !== null) return stored;
  if (order.createdAt < ABANDONMENT_TRACKING_START) return stored;

  if (order.orderStatus === 'PLACED') return 'AWAITING_PAYMENT';
  if (order.orderStatus === 'CANCELLED') return 'ABANDONED_AT_PAYMENT';
  return stored;
}
