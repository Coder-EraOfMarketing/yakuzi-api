import { OrdersService } from './orders.service';

/**
 * Cancelling a pre-order must not invent stock — and must decide that from the
 * order, not from the listing.
 *
 * Checkout takes nothing from a pre-order listing: there is no tracked stock to
 * take. So the restore in cancelOrder has nothing to give back, and run
 * unguarded it does one of two harmful things:
 *
 *   - the listing has a batch row (the normal case: a pre-order created through
 *     the seller form still gets a `DEFAULT` batch at stock 0), so the
 *     `increment` branch fires and the listing is suddenly carrying real,
 *     sellable units the seller never had;
 *   - the listing has no batch row, so the rescue `create` branch fires and
 *     *conjures* one — same outcome by a different door.
 *
 * Both are inventory out of nothing, and the seller is told nothing about it.
 * Hence the guard sits at the top of the loop rather than around either branch,
 * and it takes the waitlist "back in stock!" email with it, which is correct:
 * nobody is waiting for restock on a listing that never sold out.
 *
 * The subtler half is *which* date the guard reads. `OrderItem` carries a
 * snapshot taken at checkout and its schema docstring forbids re-reading the
 * listing, because the seller may have moved on since — and both directions of
 * drift are reachable, neither through any exotic race:
 *
 *   - clearing the date once the shipment lands is the expected end of a
 *     pre-order's life, and makes an old pre-order look ordinary;
 *   - setting a date on an existing listing makes a genuinely stock-backed
 *     order look like a pre-order.
 *
 * Neither needs a narrow window to bite. COD orders sit at
 * `paymentStatus: PENDING` for their whole life, so the entire pre-order wait
 * stays cancellable, and checkout-abandonment-sweep auto-cancels unpaid PLACED
 * orders after 30 minutes with no human involved. The two divergence tests
 * below are the ones that pin this; the rest would pass against a guard reading
 * either field.
 */

const PRE_ORDER_DATE = new Date('2026-12-15T00:00:00.000Z');

/** These fire from cancelOrder but are not what this spec is about. */
const sellerEmailsStub = { sendOrderCancelled: jest.fn() };
const adminAlertsStub = {
  shippingDetailsSubmitted: jest.fn(),
  selfShipTracking: jest.fn(),
};

describe('OrdersService.cancelOrder — a pre-order gives nothing back', () => {
  const ORDER_ID = '11111111-2222-3333-4444-555555555555';

  /**
   * `snapshot` and `offerDate` are deliberately separate knobs: the whole point
   * of the two divergence cases is that they disagree, so a harness that fed
   * one value to both could not express them.
   */
  const build = (
    spec: {
      /** OrderItem.preOrderDeliveryDate — taken at checkout, the authority. */
      snapshot: Date | null;
      /** SellerOffer.preOrderDeliveryDate — the live listing, free to drift. */
      offerDate: Date | null;
      batches: Array<{ id: string; stock: number }>;
    },
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
              quantity: 10,
              preOrderDeliveryDate: spec.snapshot,
              sellerOffer: {
                id: 'offer-1',
                preOrderDeliveryDate: spec.offerDate,
                batches: spec.batches,
              },
            },
          ],
        }),
      },
      $transaction: jest.fn().mockImplementation((cb: any) => cb(tx)),
    };

    // Ten constructor parameters, positional. Stubs for everything this spec
    // does not exercise; the notification channels resolve so the detached
    // post-commit sends do not reject.
    const service = new OrdersService(
      prisma as never,
      {} as never, // shiprocketService
      { sendMail: jest.fn().mockResolvedValue({ sent: true }) } as never,
      { notifyOrderCancelled: jest.fn().mockResolvedValue(undefined) } as never,
      { sendTransactional: jest.fn().mockResolvedValue({ success: true }) } as never,
      {} as never, // sellerOrderNotifier
      {} as never, // inventoryService
      {} as never, // integrationEvents
      sellerEmailsStub as never,
      adminAlertsStub as never,
    );
    return { service, prisma, tx };
  };

  /** Snapshot and listing agree: an ordinary, undisturbed pre-order. */
  const preOrder = (batches: Array<{ id: string; stock: number }> = []) => ({
    snapshot: PRE_ORDER_DATE,
    offerDate: PRE_ORDER_DATE,
    batches,
  });
  /** Snapshot and listing agree: an ordinary, undisturbed in-stock order. */
  const inStock = (batches: Array<{ id: string; stock: number }>) => ({
    snapshot: null,
    offerDate: null,
    batches,
  });

  describe('the guard trusts the order, not the listing', () => {
    it('gives nothing back when the seller has since CLEARED the date', async () => {
      // The conjured-inventory case, and the most important test in this file.
      // Clearing the date once the shipment lands is the normal end of a
      // pre-order's life. A guard reading the live offer sees null, falls
      // through, finds no batches — because a pre-order never had any — and
      // creates one holding 10 sellable units out of thin air.
      const { service, tx } = build({
        snapshot: PRE_ORDER_DATE,
        offerDate: null,
        batches: [],
      });

      await service.cancelOrder('buyer-1', ORDER_ID, 'BUYER');

      expect(tx.productBatch.create).not.toHaveBeenCalled();
      expect(tx.productBatch.update).not.toHaveBeenCalled();
    });

    it('still restocks when the seller has since SET a date on the listing', async () => {
      // The opposite failure: this order really did decrement 10 real units at
      // checkout, so they have to come back. A guard reading the live offer
      // would see a date, skip, and destroy them.
      const { service, tx } = build({
        snapshot: null,
        offerDate: PRE_ORDER_DATE,
        batches: [{ id: 'batch-1', stock: 0 }],
      });

      await service.cancelOrder('buyer-1', ORDER_ID, 'BUYER');

      expect(tx.productBatch.update).toHaveBeenCalledWith({
        where: { id: 'batch-1' },
        data: { stock: { increment: 10 } },
      });
    });

    it('skips when both agree it is a pre-order', async () => {
      const { service, tx } = build(preOrder());

      await service.cancelOrder('buyer-1', ORDER_ID, 'BUYER');

      expect(tx.productBatch.create).not.toHaveBeenCalled();
      expect(tx.productBatch.update).not.toHaveBeenCalled();
    });

    it('restocks when both agree it is ordinary', async () => {
      // Also the pre-feature case: orders placed before pre-orders existed
      // carry a null snapshot, and restocking them is right.
      const { service, tx } = build(inStock([{ id: 'batch-1', stock: 3 }]));

      await service.cancelOrder('buyer-1', ORDER_ID, 'BUYER');

      expect(tx.productBatch.update).toHaveBeenCalledWith({
        where: { id: 'batch-1' },
        data: { stock: { increment: 10 } },
      });
    });
  });

  it('writes no batch at all for a pre-order with no batches', async () => {
    const { service, tx } = build(preOrder());

    await service.cancelOrder('buyer-1', ORDER_ID, 'BUYER');

    expect(tx.productBatch.create).not.toHaveBeenCalled();
    expect(tx.productBatch.update).not.toHaveBeenCalled();
  });

  it('does not top up the zero-stock DEFAULT batch a real pre-order carries', async () => {
    // The realistic shape: the seller form leaves a DEFAULT batch at 0, so the
    // unguarded code takes the `increment` branch instead and the listing ends
    // up at stock 10.
    const { service, tx } = build(preOrder([{ id: 'batch-pre', stock: 0 }]));

    await service.cancelOrder('buyer-1', ORDER_ID, 'BUYER');

    expect(tx.productBatch.update).not.toHaveBeenCalled();
    expect(tx.productBatch.create).not.toHaveBeenCalled();
  });

  it('does not tell waitlisted shoppers a cancelled pre-order is back in stock', async () => {
    // The guard is at the top of the loop, so it covers the waitlist ping in
    // the same body. Nothing sold out, so nothing came back.
    const { service, tx } = build(preOrder(), [
      { id: 'w-1', userId: 'user-9', catalogProduct: { name: 'Goku Figure' } },
    ]);

    await service.cancelOrder('buyer-1', ORDER_ID, 'BUYER');

    expect(tx.notification.createMany).not.toHaveBeenCalled();
    expect(tx.productWaitlist.updateMany).not.toHaveBeenCalled();
  });

  it('still cancels the order itself', async () => {
    // Skipping the restore must not skip the cancellation — the buyer's order
    // still has to go away.
    const { service, tx } = build(preOrder());

    await service.cancelOrder('buyer-1', ORDER_ID, 'BUYER');

    expect(tx.order.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.order.updateMany.mock.calls[0][0].data.orderStatus).toBe('CANCELLED');
  });

  it('reads items whole, so the snapshot column is actually there', async () => {
    // The trap documented on PreOrderable: `isPreOrder` reads an absent key
    // exactly as it reads a stored null, so a narrow `select` on `items` would
    // turn the guard above into a silent no-op with no error to notice.
    const { service, prisma } = build(preOrder());

    await service.cancelOrder('buyer-1', ORDER_ID, 'BUYER');

    const itemsNode = prisma.order.findUnique.mock.calls[0][0].include.items;
    expect(itemsNode.select).toBeUndefined();
    expect(itemsNode.include).toBeDefined();
  });

  describe('ordinary orders are untouched', () => {
    it('still increments the existing batch', async () => {
      const { service, tx } = build(inStock([{ id: 'batch-1', stock: 3 }]));

      await service.cancelOrder('buyer-1', ORDER_ID, 'BUYER');

      expect(tx.productBatch.update).toHaveBeenCalledWith({
        where: { id: 'batch-1' },
        data: { stock: { increment: 10 } },
      });
    });

    it('still creates a batch rather than losing the units when there is none', async () => {
      // The rescue branch. It is wrong for a pre-order and right for this.
      const { service, tx } = build(inStock([]));

      await service.cancelOrder('buyer-1', ORDER_ID, 'BUYER');

      expect(tx.productBatch.create).toHaveBeenCalledWith({
        data: { sellerOfferId: 'offer-1', batchNumber: 'DEFAULT', stock: 10 },
      });
    });

    it('still tells waitlisted shoppers an ordinary product is back', async () => {
      const { service, tx } = build(inStock([{ id: 'batch-1', stock: 0 }]), [
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
});
