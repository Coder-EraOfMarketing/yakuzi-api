import { OrdersService } from './orders.service';
import type { CreateOrderDto } from './dto/create-order.dto';

/**
 * Checking out a pre-order.
 *
 * A pre-order listing has no tracked stock at all: `SellerOffer.batches` is
 * legitimately empty, any quantity is allowed, and nothing is decremented.
 * What it does carry is a promised date, which has to be copied onto the
 * OrderItem at the moment of sale — the seller is free to move the listing's
 * date afterwards, and the promise made to this buyer must not move with it.
 *
 * The one thing checkout refuses is a mixed bag. Order.orderStatus covers the
 * whole order and settlement is cut when it turns DELIVERED, so an order
 * holding both a pre-order and an in-stock item would park the in-stock
 * item — already paid for — under the pre-order's status for months, and
 * settle neither seller until then. Two pre-orders with DIFFERENT dates are
 * fine; the ban is only on mixing pre-order with in-stock.
 */

const PRE_ORDER_DATE = new Date('2026-12-15T00:00:00.000Z');
const OTHER_PRE_ORDER_DATE = new Date('2027-03-01T00:00:00.000Z');

const dto = (over: Partial<CreateOrderDto> = {}): CreateOrderDto =>
  ({
    name: 'Arko',
    phone: '9008336683',
    address: 'sss',
    city: 'ss',
    state: 'West Bengal',
    pincode: '711303',
    email: 'buyer@example.com',
    // Skips checkout()'s post-transaction seller notification, which this
    // harness does not stub. Same reason as in orders.service.spec.ts.
    deferSellerNotification: true,
    ...over,
  }) as CreateOrderDto;

/**
 * An ordinary in-stock cart line: a null date, and batches to draw from.
 */
const inStockItem = (overrides: Partial<any> = {}) => ({
  id: 'cartitem-stock',
  sellerOfferId: 'offer-stock',
  quantity: 2,
  unitPrice: 50,
  sellerOffer: {
    id: 'offer-stock',
    name: 'In Stock Figure',
    isActive: true,
    deletedAt: null,
    mrp: 100,
    finalCustomerPayable: 80,
    preOrderDeliveryDate: null,
    seller: {
      id: 'seller-1',
      verificationStatus: 'APPROVED',
      companyName: 'Acme',
      selfShipEnabled: false,
    },
    batches: [{ id: 'batch-stock', stock: 10 }],
    ...overrides,
  },
});

/**
 * A pre-order cart line: a date, and deliberately no batches at all.
 */
const preOrderItem = (overrides: Partial<any> = {}) => ({
  id: 'cartitem-pre',
  sellerOfferId: 'offer-pre',
  quantity: 2,
  unitPrice: 50,
  sellerOffer: {
    id: 'offer-pre',
    name: 'Pre Order Figure',
    isActive: true,
    deletedAt: null,
    mrp: 100,
    finalCustomerPayable: 80,
    preOrderDeliveryDate: PRE_ORDER_DATE,
    seller: {
      id: 'seller-1',
      verificationStatus: 'APPROVED',
      companyName: 'Acme',
      selfShipEnabled: false,
    },
    batches: [],
    ...overrides,
  },
});

const buildCheckout = (items: any[]) => {
  const createManyCalls: any[] = [];
  const tx = {
    order: { create: jest.fn().mockResolvedValue({ id: 'order-1' }) },
    orderItem: {
      createMany: jest.fn().mockImplementation((args: any) => {
        createManyCalls.push(args);
        return Promise.resolve({ count: args.data.length });
      }),
    },
    orderAddress: { create: jest.fn().mockResolvedValue({}) },
    productBatch: { update: jest.fn().mockResolvedValue({}) },
    cartItem: { deleteMany: jest.fn().mockResolvedValue({ count: items.length }) },
  };
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue({
        phone: '9008336683',
        email: 'buyer@example.com',
        buyerProfile: null,
      }),
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
    },
    cart: { findUnique: jest.fn().mockResolvedValue({ id: 'cart-1', items }) },
    buyerProfile: {
      findUnique: jest.fn().mockResolvedValue({ referralCodeId: null }),
      update: jest.fn().mockResolvedValue({}),
    },
    $transaction: jest.fn().mockImplementation((cb: any) => cb(tx)),
    // checkout()'s step 5 re-reads the order after the transaction; items: []
    // keeps the follow-up image loop a no-op.
    order: { findUnique: jest.fn().mockResolvedValue({ id: 'order-1', items: [] }) },
  };

  // Ten constructor parameters, appended and never inserted — see the comment
  // on OrdersService's constructor. Positional, with stubs for everything this
  // spec does not exercise.
  const inventoryService = { getTotalStock: jest.fn().mockResolvedValue(0) };
  const integrationEvents = { fanOutYukiziChange: jest.fn().mockResolvedValue(undefined) };
  const service = new OrdersService(
    prisma as never,
    {} as never, // shiprocketService
    {} as never, // mailService
    {} as never, // notificationsService
    {} as never, // otpSmsService
    {} as never, // sellerOrderNotifier — unused thanks to deferSellerNotification
    inventoryService as never,
    integrationEvents as never,
    {} as never, // sellerEmails
    {} as never, // adminAlerts
  );
  return { service, prisma, tx, createManyCalls, integrationEvents };
};

const createdItems = (createManyCalls: any[]) =>
  createManyCalls.flatMap((call) => call.data);

describe('checkout loads the pre-order column', () => {
  /**
   * The trap documented on PreOrderable: `isPreOrder` reads an absent key
   * exactly as it reads a stored null, so a narrow `select` that forgets this
   * column turns every check below into a silent no-op. checkout() must keep
   * reading the offer through `include`, which returns all scalars.
   */
  it('reads the offer with include, not a narrow select', async () => {
    const { service, prisma } = buildCheckout([inStockItem()]);

    await service.checkout('buyer-1', dto());

    const args = prisma.cart.findUnique.mock.calls[0][0];
    const offerNode = args.include.items.include.sellerOffer;
    expect(offerNode.select).toBeUndefined();
    expect(offerNode.include).toBeDefined();
  });
});

describe('checkout — the mixed-cart rule', () => {
  it('refuses a cart holding both a pre-order and an in-stock item', async () => {
    const { service } = buildCheckout([preOrderItem(), inStockItem()]);

    await expect(service.checkout('buyer-1', dto())).rejects.toThrow(
      /Pre-order items must be ordered on their own/,
    );
  });

  it('names the pre-order lines so the buyer knows what to pull out', async () => {
    const { service } = buildCheckout([preOrderItem(), inStockItem()]);

    // Asserted whole, not just on the product name: the old stock gate also
    // quoted the name ("Insufficient stock for ... Only 0 units available"),
    // so a name-only assertion passed even with this rule removed.
    await expect(service.checkout('buyer-1', dto())).rejects.toThrow(
      'Pre-order items must be ordered on their own. Either remove ' +
        '"Pre Order Figure" from your bag, or order only those.',
    );
  });

  it('refuses the mix whichever way round the lines sit', async () => {
    const { service } = buildCheckout([inStockItem(), preOrderItem()]);

    await expect(service.checkout('buyer-1', dto())).rejects.toThrow(
      /ordered on their own/,
    );
  });

  it('places nothing at all when the cart is mixed', async () => {
    // The pre-order line is given batches it does not need, so nothing else
    // in checkout could have stopped this cart — only the mixed-cart rule.
    const { service, prisma } = buildCheckout([
      preOrderItem({ batches: [{ id: 'batch-pre', stock: 50 }] }),
      inStockItem(),
    ]);

    await expect(service.checkout('buyer-1', dto())).rejects.toThrow();

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('accepts a cart of only pre-orders with DIFFERENT promised dates', async () => {
    // Two dates in one order is explicitly allowed: the ban is on mixing
    // pre-order with in-stock, not on disagreeing dates.
    const { service, createManyCalls } = buildCheckout([
      preOrderItem(),
      {
        ...preOrderItem({ preOrderDeliveryDate: OTHER_PRE_ORDER_DATE }),
        id: 'cartitem-pre-2',
        sellerOfferId: 'offer-pre-2',
      },
    ]);

    await expect(service.checkout('buyer-1', dto())).resolves.toBeTruthy();

    const dates = createdItems(createManyCalls).map(
      (i) => i.preOrderDeliveryDate,
    );
    expect(dates).toEqual([PRE_ORDER_DATE, OTHER_PRE_ORDER_DATE]);
  });

  it('accepts an ordinary cart of only in-stock items', async () => {
    const { service } = buildCheckout([inStockItem()]);

    await expect(service.checkout('buyer-1', dto())).resolves.toBeTruthy();
  });
});

describe('checkout — stock validation skips a pre-order', () => {
  it('lets a large quantity through on a listing with no batches', async () => {
    const { service } = buildCheckout([
      { ...preOrderItem(), quantity: 500 },
    ]);

    await expect(service.checkout('buyer-1', dto())).resolves.toBeTruthy();
  });

  it('still rejects an ordinary line that asks for more than exists', async () => {
    // No-regression: the stock gate has to keep working for everything that
    // is not a pre-order.
    const { service } = buildCheckout([
      { ...inStockItem({ batches: [{ id: 'batch-stock', stock: 1 }] }), quantity: 5 },
    ]);

    await expect(service.checkout('buyer-1', dto())).rejects.toThrow(
      'Insufficient stock for "In Stock Figure". Only 1 units available.',
    );
  });

  it('still charges the live price on a pre-order line', async () => {
    const { service, createManyCalls } = buildCheckout([preOrderItem()]);

    await service.checkout('buyer-1', dto());

    expect(createdItems(createManyCalls)[0].unitPrice).toBe(80);
  });

  it('still rejects a deactivated pre-order listing', async () => {
    const { service } = buildCheckout([preOrderItem({ isActive: false })]);

    await expect(service.checkout('buyer-1', dto())).rejects.toThrow(
      'Product "Pre Order Figure" is no longer available. Please remove it from your cart.',
    );
  });
});

describe('checkout — a pre-order decrements nothing', () => {
  it('does not touch a batch for a pre-order line', async () => {
    const { service, tx } = buildCheckout([
      // Batches present and plentiful, so the only reason not to decrement is
      // that this is a pre-order.
      preOrderItem({ batches: [{ id: 'batch-pre', stock: 50 }] }),
    ]);

    await service.checkout('buyer-1', dto());

    expect(tx.productBatch.update).not.toHaveBeenCalled();
  });

  it('still decrements an ordinary line', async () => {
    const { service, tx } = buildCheckout([inStockItem()]);

    await service.checkout('buyer-1', dto());

    expect(tx.productBatch.update).toHaveBeenCalledWith({
      where: { id: 'batch-stock' },
      data: { stock: { decrement: 2 } },
    });
  });

  it('tells no sales channel that a pre-order moved stock', async () => {
    const { service, integrationEvents } = buildCheckout([preOrderItem()]);

    await service.checkout('buyer-1', dto());

    expect(integrationEvents.fanOutYukiziChange).not.toHaveBeenCalled();
  });

  it('still tells the sales channels about an ordinary line', async () => {
    const { service, integrationEvents } = buildCheckout([inStockItem()]);

    await service.checkout('buyer-1', dto());

    expect(integrationEvents.fanOutYukiziChange).toHaveBeenCalledWith(
      'seller-1',
      'offer-stock',
      0,
    );
  });
});

describe('checkout — the promised date is snapshotted onto the OrderItem', () => {
  it("copies the offer's date onto a pre-order OrderItem", async () => {
    const { service, createManyCalls } = buildCheckout([preOrderItem()]);

    await service.checkout('buyer-1', dto());

    expect(createdItems(createManyCalls)[0].preOrderDeliveryDate).toEqual(
      PRE_ORDER_DATE,
    );
  });

  it('writes null for an ordinary OrderItem', async () => {
    const { service, createManyCalls } = buildCheckout([inStockItem()]);

    await service.checkout('buyer-1', dto());

    expect(createdItems(createManyCalls)[0].preOrderDeliveryDate).toBeNull();
  });

  it('writes the date it saw, not a later edit of the listing', async () => {
    // A snapshot, not a lookup: mutating the offer after checkout must not
    // change what was written.
    const item = preOrderItem();
    const { service, createManyCalls } = buildCheckout([item]);

    await service.checkout('buyer-1', dto());
    item.sellerOffer.preOrderDeliveryDate = OTHER_PRE_ORDER_DATE;

    expect(createdItems(createManyCalls)[0].preOrderDeliveryDate).toEqual(
      PRE_ORDER_DATE,
    );
  });
});
