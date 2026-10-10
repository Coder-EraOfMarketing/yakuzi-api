import { OrdersService } from './orders.service';

/**
 * What date `/orders/seller` reports for a pre-order.
 *
 * `getSellerOrders` does not return rows as Prisma loaded them — it groups
 * items by order and rebuilds each one from an explicit field list. That makes
 * the response shape a deliberate choice rather than a consequence of the
 * query, and it is the reason this spec exists: adding a column to the `select`
 * does not put it on the wire, and selecting the *wrong* column puts a
 * plausible-looking wrong answer on the wire.
 *
 * Two dates are in play. `OrderItem.preOrderDeliveryDate` is the snapshot taken
 * at checkout and is the promise the buyer actually holds.
 * `SellerOffer.preOrderDeliveryDate` is the live listing, which the seller may
 * have edited or cleared since. A seller dashboard rendering "promised
 * delivery" from the listing would show whatever was last saved — the exact
 * re-read the OrderItem docstring forbids, reproduced at the presentation
 * layer.
 *
 * So the response carries the snapshot, and deliberately does not carry the
 * live date at all: the wrong answer is made unavailable rather than merely
 * documented as wrong.
 */

const SNAPSHOT_DATE = new Date('2026-12-15T00:00:00.000Z');
const LISTING_DATE_NOW = new Date('2027-06-01T00:00:00.000Z');

const build = (item: {
  preOrderDeliveryDate: Date | null;
  sellerOffer: Record<string, unknown>;
}) => {
  const prisma = {
    sellerProfile: {
      findUnique: jest.fn().mockResolvedValue({ id: 'seller-1', userId: 'user-1' }),
    },
    orderItem: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'item-1',
          quantity: 2,
          unitPrice: 50,
          totalPrice: 100,
          sellerId: 'seller-1',
          ...item,
          order: {
            id: 'order-1',
            buyerId: 'buyer-1',
            orderStatus: 'PLACED',
            paymentStatus: 'PENDING',
            createdAt: new Date('2026-10-01T00:00:00.000Z'),
            address: null,
          },
        },
      ]),
    },
  };

  const service = new OrdersService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, prisma };
};

const offer = (over: Record<string, unknown> = {}) => ({
  id: 'offer-1',
  name: 'Pre Order Figure',
  manufacturer: 'Acme',
  mrp: 100,
  catalogProduct: null,
  variant: null,
  ...over,
});

describe('getSellerOrders — which pre-order date reaches the seller', () => {
  it("reports the order's snapshot, not the listing's current date", async () => {
    // The two disagree, so only one of them can be what comes back. The
    // snapshot is the promise; the listing has moved on since.
    const { service } = build({
      preOrderDeliveryDate: SNAPSHOT_DATE,
      sellerOffer: offer({ preOrderDeliveryDate: LISTING_DATE_NOW }),
    });

    const result = await service.getSellerOrders('user-1');

    expect(result[0].items[0].preOrderDeliveryDate).toEqual(SNAPSHOT_DATE);
  });

  it('does not ask the database for the listing date', async () => {
    // This is the assertion that actually enforces the rule, so it is the one
    // to keep. `product` is `item.sellerOffer` passed through verbatim — the
    // mapping prunes nothing — so the select is the only thing standing
    // between a seller client and the wrong date. Put the column back in the
    // select and it is on the wire again, which is why this is pinned here
    // rather than left to the comment beside it.
    const { service, prisma } = build({
      preOrderDeliveryDate: SNAPSHOT_DATE,
      sellerOffer: offer(),
    });

    await service.getSellerOrders('user-1');

    const select = prisma.orderItem.findMany.mock.calls[0][0].include.sellerOffer.select;
    expect(select.preOrderDeliveryDate).toBeUndefined();
  });

  it('leaves no listing date on the item, given the row the select returns', async () => {
    // The offer here is shaped as that select really produces it: no
    // preOrderDeliveryDate on the row at all. Deliberately not fed a row
    // carrying the column — a database does not return what was not asked
    // for, and a test that pretended otherwise would be asserting pruning
    // this method does not do.
    const { service } = build({
      preOrderDeliveryDate: SNAPSHOT_DATE,
      sellerOffer: offer(),
    });

    const result = await service.getSellerOrders('user-1');

    expect(result[0].items[0].product).not.toHaveProperty('preOrderDeliveryDate');
    // And the authoritative value is still right there beside it.
    expect(result[0].items[0].preOrderDeliveryDate).toEqual(SNAPSHOT_DATE);
  });

  it('reports null for an ordinary order', async () => {
    const { service } = build({
      preOrderDeliveryDate: null,
      sellerOffer: offer(),
    });

    const result = await service.getSellerOrders('user-1');

    expect(result[0].items[0].preOrderDeliveryDate).toBeNull();
  });
});
