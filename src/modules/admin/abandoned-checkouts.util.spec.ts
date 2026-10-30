import {
  ABANDONMENT_TRACKING_START,
  AbandonedOrderRow,
  boughtLater,
  groupAbandonedCheckouts,
  summariseAbandoned,
} from './abandoned-checkouts.util';

const at = (iso: string) => new Date(iso);

const row = (over: Partial<AbandonedOrderRow> = {}): AbandonedOrderRow => ({
  id: 'o1',
  buyerId: 'b1',
  checkoutGroupId: null,
  orderStatus: 'CANCELLED',
  totalAmount: 1000,
  createdAt: at('2026-10-20T10:00:00Z'),
  cancelledAt: at('2026-10-20T10:40:00Z'),
  cancellationReason: null,
  ...over,
});

describe('groupAbandonedCheckouts', () => {
  it('collapses a multi-seller basket into ONE abandoned checkout', () => {
    // checkout() makes one Order per seller under a shared checkoutGroupId.
    // Without grouping this reads as three abandonments and triple-counts it.
    const groups = groupAbandonedCheckouts([
      row({ id: 'a', checkoutGroupId: 'g1', totalAmount: 500 }),
      row({ id: 'b', checkoutGroupId: 'g1', totalAmount: 700 }),
      row({ id: 'c', checkoutGroupId: 'g1', totalAmount: 300 }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].orderIds).toEqual(['a', 'b', 'c']);
    expect(groups[0].totalAmount).toBe(1500);
  });

  it('keeps an order with no group id as its own checkout', () => {
    // Orders that predate checkoutGroupId carry null.
    const groups = groupAbandonedCheckouts([
      row({ id: 'a', checkoutGroupId: null }),
      row({ id: 'b', checkoutGroupId: null }),
    ]);
    expect(groups.map((g) => g.key).sort()).toEqual(['a', 'b']);
  });

  it('does not merge different groups, even for the same buyer', () => {
    const groups = groupAbandonedCheckouts([
      row({ id: 'a', checkoutGroupId: 'g1' }),
      row({ id: 'b', checkoutGroupId: 'g2' }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it('is in progress while ANY order in the group is still PLACED', () => {
    // The sweep cancels orders one at a time, so a group is briefly part
    // cancelled. Calling it abandoned early invites chasing a buyer the sweep
    // is still emailing.
    const groups = groupAbandonedCheckouts([
      row({ id: 'a', checkoutGroupId: 'g1', orderStatus: 'CANCELLED' }),
      row({ id: 'b', checkoutGroupId: 'g1', orderStatus: 'PLACED', cancelledAt: null }),
    ]);
    expect(groups[0].state).toBe('in_progress');
  });

  it('is abandoned once every order in the group is cancelled', () => {
    const groups = groupAbandonedCheckouts([
      row({ id: 'a', checkoutGroupId: 'g1' }),
      row({ id: 'b', checkoutGroupId: 'g1' }),
    ]);
    expect(groups[0].state).toBe('abandoned');
  });

  it('uses the earliest start and the latest cancellation', () => {
    const groups = groupAbandonedCheckouts([
      row({
        id: 'a',
        checkoutGroupId: 'g1',
        createdAt: at('2026-10-20T10:00:05Z'),
        cancelledAt: at('2026-10-20T10:40:00Z'),
      }),
      row({
        id: 'b',
        checkoutGroupId: 'g1',
        createdAt: at('2026-10-20T10:00:00Z'),
        cancelledAt: at('2026-10-20T10:40:09Z'),
      }),
    ]);
    expect(groups[0].startedAt).toEqual(at('2026-10-20T10:00:00Z'));
    expect(groups[0].cancelledAt).toEqual(at('2026-10-20T10:40:09Z'));
  });

  it('takes the first cancellation reason present', () => {
    const groups = groupAbandonedCheckouts([
      row({ id: 'a', checkoutGroupId: 'g1', cancellationReason: null }),
      row({ id: 'b', checkoutGroupId: 'g1', cancellationReason: 'Payment window closed' }),
    ]);
    expect(groups[0].cancellationReason).toBe('Payment window closed');
  });

  it('has no cancelledAt while nothing in it is cancelled', () => {
    const groups = groupAbandonedCheckouts([
      row({ orderStatus: 'PLACED', cancelledAt: null }),
    ]);
    expect(groups[0].cancelledAt).toBeNull();
  });

  it('sums money without floating-point drift', () => {
    // 0.1 + 0.2 !== 0.3 in IEEE floats; an admin screen showing ₹0.30000000000000004
    // looks broken.
    const groups = groupAbandonedCheckouts([
      row({ id: 'a', checkoutGroupId: 'g1', totalAmount: 0.1 }),
      row({ id: 'b', checkoutGroupId: 'g1', totalAmount: 0.2 }),
    ]);
    expect(groups[0].totalAmount).toBe(0.3);
  });

  it('sorts newest checkout first', () => {
    const groups = groupAbandonedCheckouts([
      row({ id: 'old', createdAt: at('2026-10-01T00:00:00Z') }),
      row({ id: 'new', createdAt: at('2026-10-25T00:00:00Z') }),
      row({ id: 'mid', createdAt: at('2026-10-10T00:00:00Z') }),
    ]);
    expect(groups.map((g) => g.key)).toEqual(['new', 'mid', 'old']);
  });

  it('returns nothing for nothing', () => {
    expect(groupAbandonedCheckouts([])).toEqual([]);
  });
});

describe('summariseAbandoned', () => {
  it('counts and values each state separately', () => {
    const groups = groupAbandonedCheckouts([
      row({ id: 'a', totalAmount: 1000 }),
      row({ id: 'b', totalAmount: 250.5 }),
      row({ id: 'c', orderStatus: 'PLACED', cancelledAt: null, totalAmount: 400 }),
    ]);
    expect(summariseAbandoned(groups)).toEqual({
      abandonedCount: 2,
      abandonedValue: 1250.5,
      inProgressCount: 1,
      inProgressValue: 400,
    });
  });

  it('is all zeros for an empty list', () => {
    expect(summariseAbandoned([])).toEqual({
      abandonedCount: 0,
      abandonedValue: 0,
      inProgressCount: 0,
      inProgressValue: 0,
    });
  });
});

describe('boughtLater', () => {
  const group = { buyerId: 'b1', startedAt: at('2026-10-20T10:00:00Z') };

  it('is true when the same buyer purchased afterwards', () => {
    expect(
      boughtLater(group, [{ buyerId: 'b1', createdAt: at('2026-10-21T09:00:00Z') }]),
    ).toBe(true);
  });

  it('is false for a purchase BEFORE the abandonment', () => {
    // They bought something last week; that says nothing about whether this
    // basket was recovered.
    expect(
      boughtLater(group, [{ buyerId: 'b1', createdAt: at('2026-10-10T09:00:00Z') }]),
    ).toBe(false);
  });

  it('is false for another buyer', () => {
    expect(
      boughtLater(group, [{ buyerId: 'b2', createdAt: at('2026-10-21T09:00:00Z') }]),
    ).toBe(false);
  });

  it('is false for a purchase in the very same instant (same checkout)', () => {
    expect(
      boughtLater(group, [{ buyerId: 'b1', createdAt: at('2026-10-20T10:00:00Z') }]),
    ).toBe(false);
  });

  it('is false with no purchases', () => {
    expect(boughtLater(group, [])).toBe(false);
  });
});

describe('ABANDONMENT_TRACKING_START', () => {
  it('matches the defer_seller_notification migration timestamp', () => {
    // sellersNotifiedAt has no backfill, so orders older than the migration
    // cannot be classified. If this moves, so must the migration it mirrors.
    expect(ABANDONMENT_TRACKING_START.toISOString()).toBe('2026-08-19T11:00:00.000Z');
  });
});
