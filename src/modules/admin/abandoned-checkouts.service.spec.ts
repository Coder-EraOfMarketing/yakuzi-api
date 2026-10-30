import { OrderStatus, PaymentStatus } from '@prisma/client';
import { AdminService } from './admin.service';

const at = (iso: string) => new Date(iso);

const orderRow = (over: Record<string, unknown> = {}) => ({
  id: 'o1',
  buyerId: 'b1',
  checkoutGroupId: null,
  orderStatus: OrderStatus.CANCELLED,
  totalAmount: '1000.00',
  createdAt: at('2026-10-20T10:00:00Z'),
  cancelledAt: at('2026-10-20T10:40:00Z'),
  cancellationReason: null,
  ...over,
});

const detail = (id: string, name = 'Naruto Figure') => ({
  id,
  buyer: { id: 'b1', phone: '9000000001', email: 'b@example.com', buyerProfile: null },
  address: { name: 'Asha', phone: '9000000001', city: 'Pune', state: 'MH' },
  items: [{ quantity: 1, totalPrice: '1000.00', sellerOffer: { name } }],
});

// findMany is called three times, in order: the narrow candidate rows, then
// (together) the page's detail rows and the buyers' later purchases.
const build = (rows: unknown[] = [], details: unknown[] = [], purchases: unknown[] = []) => {
  const prisma = {
    order: {
      findMany: jest
        .fn()
        .mockResolvedValueOnce(rows)
        .mockResolvedValueOnce(details)
        .mockResolvedValueOnce(purchases),
    },
    systemSetting: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const service = new AdminService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { get: jest.fn().mockReturnValue(undefined) } as never,
    { settlementPaid: jest.fn() } as never,
    { forSettlement: jest.fn() } as never,
    { render: jest.fn(), filename: jest.fn() } as never,
    { sendRefundIssued: jest.fn() } as never,
  );
  return { service, prisma };
};

describe('AdminService.getAbandonedCheckouts — what counts as abandoned', () => {
  it('selects only unpaid orders that never notified a seller', async () => {
    // The whole definition. sellersNotifiedAt null is what separates an
    // abandoned card checkout from a COD order, which also sits at PENDING.
    const { service, prisma } = build();

    await service.getAbandonedCheckouts({} as never);

    const where = prisma.order.findMany.mock.calls[0][0].where;
    expect(where.sellersNotifiedAt).toBeNull();
    expect(where.orderStatus).toEqual({ in: [OrderStatus.PLACED, OrderStatus.CANCELLED] });
    expect(where.paymentStatus).toEqual({
      notIn: [PaymentStatus.SUCCESS, PaymentStatus.PARTIAL],
    });
  });

  it('never reaches back before sellersNotifiedAt existed', async () => {
    // No backfill: every older order is null, so without this floor years of
    // ordinary cancelled orders would be reported as abandoned checkouts.
    const { service, prisma } = build();

    await service.getAbandonedCheckouts({} as never);

    expect(prisma.order.findMany.mock.calls[0][0].where.createdAt.gte).toEqual(
      at('2026-08-19T11:00:00.000Z'),
    );
  });

  it('cannot be talked back before the floor by dateFrom', async () => {
    const { service, prisma } = build();

    await service.getAbandonedCheckouts({ dateFrom: '2020-01-01' } as never);

    expect(prisma.order.findMany.mock.calls[0][0].where.createdAt.gte).toEqual(
      at('2026-08-19T11:00:00.000Z'),
    );
  });

  it('honours a dateFrom after the floor', async () => {
    const { service, prisma } = build();

    await service.getAbandonedCheckouts({ dateFrom: '2026-10-01' } as never);

    expect(prisma.order.findMany.mock.calls[0][0].where.createdAt.gte).toEqual(
      at('2026-10-01T00:00:00.000Z'),
    );
  });

  it('treats a bare dateTo as the END of that day', async () => {
    // new Date("2026-10-31") is midnight, which would drop the whole day the
    // admin just picked.
    const { service, prisma } = build();

    await service.getAbandonedCheckouts({ dateTo: '2026-10-31' } as never);

    expect(prisma.order.findMany.mock.calls[0][0].where.createdAt.lte).toEqual(
      at('2026-10-31T23:59:59.999Z'),
    );
  });

  it('excludes internal test accounts unless asked', async () => {
    const first = build();
    await first.service.getAbandonedCheckouts({} as never);
    expect(first.prisma.order.findMany.mock.calls[0][0].where.AND).toHaveLength(1);

    const second = build();
    await second.service.getAbandonedCheckouts({ includeTestOrders: 'true' } as never);
    expect(second.prisma.order.findMany.mock.calls[0][0].where.AND).toBeUndefined();
  });

  it('adds the search clause alongside the test-order exclusion, not instead of it', async () => {
    const { service, prisma } = build();

    await service.getAbandonedCheckouts({ search: '9000' } as never);

    // Composed into AND so the search OR cannot collide with the test filter's OR.
    expect(prisma.order.findMany.mock.calls[0][0].where.AND).toHaveLength(2);
  });
});

describe('AdminService.getAbandonedCheckouts — shaping the result', () => {
  it('collapses a multi-seller checkout into one row with the combined value', async () => {
    const { service } = build(
      [
        orderRow({ id: 'a', checkoutGroupId: 'g1', totalAmount: '500.00' }),
        orderRow({ id: 'b', checkoutGroupId: 'g1', totalAmount: '700.00' }),
      ],
      [detail('a', 'Funko Pop'), detail('b', 'Naruto Figure')],
    );

    const res = await service.getAbandonedCheckouts({} as never);

    expect(res.total).toBe(1);
    expect(res.data[0].totalAmount).toBe(1200);
    expect(res.data[0].items.map((i) => i.name).sort()).toEqual(['Funko Pop', 'Naruto Figure']);
    expect(res.summary.abandonedCount).toBe(1);
    expect(res.summary.abandonedValue).toBe(1200);
  });

  it('defaults to settled abandonments but still reports the in-progress figure', async () => {
    const { service } = build(
      [
        orderRow({ id: 'done' }),
        orderRow({
          id: 'live',
          orderStatus: OrderStatus.PLACED,
          cancelledAt: null,
          totalAmount: '400.00',
        }),
      ],
      [detail('done')],
    );

    const res = await service.getAbandonedCheckouts({} as never);

    expect(res.data.map((r) => r.id)).toEqual(['done']);
    // The header shows both whichever tab is open.
    expect(res.summary).toMatchObject({
      abandonedCount: 1,
      inProgressCount: 1,
      inProgressValue: 400,
    });
  });

  it('lists only in-progress checkouts when asked', async () => {
    const { service } = build(
      [
        orderRow({ id: 'done' }),
        orderRow({ id: 'live', orderStatus: OrderStatus.PLACED, cancelledAt: null }),
      ],
      [detail('live')],
    );

    const res = await service.getAbandonedCheckouts({ state: 'in_progress' } as never);

    expect(res.data.map((r) => r.id)).toEqual(['live']);
    expect(res.data[0].state).toBe('in_progress');
  });

  it('flags a buyer who purchased after abandoning', async () => {
    const { service } = build(
      [orderRow({ id: 'a' })],
      [detail('a')],
      [{ buyerId: 'b1', createdAt: at('2026-10-22T09:00:00Z') }],
    );

    const res = await service.getAbandonedCheckouts({} as never);

    expect(res.data[0].boughtLater).toBe(true);
  });

  it('looks for later purchases only among genuinely placed orders', async () => {
    // A cancelled or unnotified order is not a purchase; counting one would
    // mark every abandoner as recovered.
    const { service, prisma } = build([orderRow({ id: 'a' })], [detail('a')]);

    await service.getAbandonedCheckouts({} as never);

    const purchaseWhere = prisma.order.findMany.mock.calls[2][0].where;
    expect(purchaseWhere.sellersNotifiedAt).toEqual({ not: null });
    expect(purchaseWhere.orderStatus).toEqual({ not: OrderStatus.CANCELLED });
  });

  it('paginates the grouped list, not the raw orders', async () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      orderRow({ id: `o${i}`, createdAt: at(`2026-10-2${i}T10:00:00Z`) }),
    );
    const { service, prisma } = build(rows, [detail('o4'), detail('o3')]);

    const res = await service.getAbandonedCheckouts({ page: 1, limit: 2 } as never);

    expect(res.total).toBe(5);
    expect(res.totalPages).toBe(3);
    expect(res.data).toHaveLength(2);
    // Only the page's orders are fetched in full, newest first.
    expect(prisma.order.findMany.mock.calls[1][0].where.id.in).toEqual(['o4', 'o3']);
  });

  it('reports truncation when the row cap is hit', async () => {
    const rows = Array.from({ length: 5000 }, (_, i) => orderRow({ id: `o${i}` }));
    const { service } = build(rows, []);

    const res = await service.getAbandonedCheckouts({ limit: 1 } as never);

    expect(res.truncated).toBe(true);
  });

  it('is empty and untruncated when nothing was abandoned', async () => {
    const { service } = build([], []);

    const res = await service.getAbandonedCheckouts({} as never);

    expect(res).toMatchObject({ data: [], total: 0, totalPages: 0, truncated: false });
    expect(res.summary.abandonedCount).toBe(0);
  });
});
