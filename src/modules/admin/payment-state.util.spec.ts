import { derivePaymentState, PaymentStateInput } from './payment-state.util';

const order = (over: Partial<PaymentStateInput> = {}): PaymentStateInput => ({
  paymentStatus: 'PENDING',
  orderStatus: 'CANCELLED',
  sellersNotifiedAt: null,
  createdAt: new Date('2026-11-03T05:00:00Z'),
  ...over,
});

describe('derivePaymentState', () => {
  it('cancelled unpaid Razorpay checkout is abandoned at payment', () => {
    expect(derivePaymentState(order())).toBe('ABANDONED_AT_PAYMENT');
  });

  it('still-placed unpaid Razorpay checkout is awaiting payment', () => {
    expect(derivePaymentState(order({ orderStatus: 'PLACED' }))).toBe('AWAITING_PAYMENT');
  });

  it('a FAILED payment on an unpaid checkout reads the same way', () => {
    expect(derivePaymentState(order({ paymentStatus: 'FAILED' }))).toBe('ABANDONED_AT_PAYMENT');
  });

  it('never relabels a paid or part-paid order, even if sellers were never stamped', () => {
    expect(derivePaymentState(order({ paymentStatus: 'SUCCESS' }))).toBe('SUCCESS');
    expect(derivePaymentState(order({ paymentStatus: 'PARTIAL', orderStatus: 'PLACED' }))).toBe('PARTIAL');
  });

  it('keeps PENDING for a manually confirmed order (sellers already notified)', () => {
    const o = order({ sellersNotifiedAt: new Date('2026-11-03T05:00:01Z'), orderStatus: 'PLACED' });
    expect(derivePaymentState(o)).toBe('PENDING');
    expect(derivePaymentState({ ...o, orderStatus: 'CANCELLED' })).toBe('PENDING');
  });

  it('does not guess when sellersNotifiedAt was not loaded', () => {
    expect(derivePaymentState(order({ sellersNotifiedAt: undefined }))).toBe('PENDING');
  });

  it('does not classify orders from before sellersNotifiedAt existed', () => {
    expect(derivePaymentState(order({ createdAt: new Date('2026-08-01T00:00:00Z') }))).toBe('PENDING');
  });

  it('leaves orders that moved on (accepted, shipped) as stored', () => {
    expect(derivePaymentState(order({ orderStatus: 'ACCEPTED' }))).toBe('PENDING');
    expect(derivePaymentState(order({ orderStatus: 'DELIVERED' }))).toBe('PENDING');
  });
});
