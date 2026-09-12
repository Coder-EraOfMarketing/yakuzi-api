import { OrdersService } from './orders.service';

/**
 * Cancelling an order must always give the stock back.
 *
 * It used to load only batches whose expiry was still in the future, then skip
 * the restore entirely when that list came back empty. Every listing carries an
 * invented expiry date (the seller form sent 2099-12-31, channel syncs sent "a
 * year from now"), so this was a timer: on the day those dates passed, a
 * cancellation would silently destroy the stock and the people waiting for the
 * product would never be told it was back.
 */
describe('OrdersService.cancelOrder — restock', () => {
  const ORDER_ID = '11111111-2222-3333-4444-555555555555';

  const build = (
    batches: Array<{ id: string; stock: number }>,
    waitlisted: Array<{ id: string; userId: string; catalogProduct: { name: string } }> = [],
  ) => {
    const tx = {
      order: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ id: ORDER_ID, orderStatus: 'CANCELLED' }),
      },
      productBatch: { update: jest.fn(), create: jest.fn() },
      sellerOffer: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'offer-1', variant: { catalogProductId: 'cat-1' } }),
      },
      productWaitlist: {
        findMany: jest.fn().mockResolvedValue(waitlisted),
        updateMany: jest.fn(),
      },
      notification: { createMany: jest.fn() },
    };

    const prisma = {
      order: {
        findUnique: jest.fn().mockResolvedValue({
          id: ORDER_ID,
          buyerId: 'buyer-1',
          orderStatus: 'PLACED',
          paymentStatus: 'PENDING',
          buyer: { email: 'buyer@example.com', phone: '9000000000' },
          items: [
            {
              id: 'item-1',
              quantity: 2,
              sellerOffer: { id: 'offer-1', batches },
            },
          ],
        }),
      },
      $transaction: jest.fn().mockImplementation((cb: any) => cb(tx)),
    };

    const service = new OrdersService(
      prisma as never,
      {} as never,
      { sendMail: jest.fn().mockResolvedValue({ sent: true }) } as never,
      { notifyOrderCancelled: jest.fn().mockResolvedValue(undefined) } as never,
      { sendTransactional: jest.fn().mockResolvedValue({ success: true }) } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { service, prisma, tx };
  };

  it('puts the units back on the listing', async () => {
    const { service, tx } = build([{ id: 'batch-1', stock: 3 }]);

    await service.cancelOrder('buyer-1', ORDER_ID, 'BUYER');

    expect(tx.productBatch.update).toHaveBeenCalledWith({
      where: { id: 'batch-1' },
      data: { stock: { increment: 2 } },
    });
  });

  it('reads batches without filtering them by a date', async () => {
    // The filter is what made this a time bomb; it must not come back.
    const { service, prisma } = build([{ id: 'batch-1', stock: 3 }]);

    await service.cancelOrder('buyer-1', ORDER_ID, 'BUYER');

    const args = JSON.stringify(prisma.order.findUnique.mock.calls[0][0]);
    expect(args).not.toContain('expiryDate');
  });

  it('creates a batch rather than losing the units when the listing has none', async () => {
    const { service, tx } = build([]);

    await service.cancelOrder('buyer-1', ORDER_ID, 'BUYER');

    expect(tx.productBatch.create).toHaveBeenCalledWith({
      data: { sellerOfferId: 'offer-1', batchNumber: 'DEFAULT', stock: 2 },
    });
  });

  it('tells waitlisted shoppers the product is back, even on that path', async () => {
    // Previously this sat inside the "did an unexpired batch exist" branch, so
    // the notification disappeared along with the stock.
    const { service, tx } = build([], [
      { id: 'w-1', userId: 'user-9', catalogProduct: { name: 'Goku Figure' } },
    ]);

    await service.cancelOrder('buyer-1', ORDER_ID, 'BUYER');

    expect(tx.notification.createMany).toHaveBeenCalledWith({
      data: [
        {
          userId: 'user-9',
          message: 'The product Goku Figure you were waiting for is now back in stock!',
        },
      ],
    });
    expect(tx.productWaitlist.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['w-1'] } },
      data: { isNotified: true },
    });
  });
});
