import { CartService } from './cart.service';

/**
 * The cart's three stock gates, and what a pre-order does to each.
 *
 * A pre-order listing carries no ProductBatch rows at all, so `batches: []`
 * here is not an out-of-stock listing — it is what every pre-order looks
 * like. Each test below pairs the pre-order case with the ordinary one that
 * must keep refusing, because the whole risk in this change is a gate that
 * stops applying to everybody.
 */

const PRE_ORDER_DATE = new Date('2026-12-01T00:00:00.000Z');

/** An offer shaped as the cart's queries return it. No batches by default. */
const offer = (overrides: Partial<any> = {}) => ({
  id: 'offer-1',
  name: 'Widget',
  manufacturer: 'Acme',
  mrp: 100,
  finalCustomerPayable: 90,
  gstPercent: 12,
  minimumOrderQuantity: 1,
  maximumOrderQuantity: null,
  shippingCharges: 0,
  finalShippingPrice: null,
  isActive: true,
  deletedAt: null,
  // The flag is the date's presence; null means an ordinary listing.
  preOrderDeliveryDate: null,
  batches: [],
  catalogProduct: null,
  variant: null,
  seller: {
    id: 'seller-1',
    companyName: 'Acme Co',
    city: 'Kolkata',
    state: 'WB',
    rating: 4.5,
  },
  ...overrides,
});

const preOrderOffer = (overrides: Partial<any> = {}) =>
  offer({ preOrderDeliveryDate: PRE_ORDER_DATE, ...overrides });

// ──────────────────────────────────────────────
// addToCart
// ──────────────────────────────────────────────

const buildAdd = (sellerOffer: any) => {
  const prisma = {
    sellerOffer: {
      findFirst: jest.fn().mockResolvedValue(sellerOffer),
    },
    catalogProduct: {
      // No master found: that branch is left alone, so it cannot mask the
      // stock gate under test.
      findFirst: jest.fn().mockResolvedValue(null),
    },
    cart: {
      findUnique: jest.fn().mockResolvedValue({ id: 'cart-1' }),
      create: jest.fn().mockResolvedValue({ id: 'cart-1' }),
    },
    cartItem: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(({ data }: any) =>
        Promise.resolve({
          id: 'item-1',
          ...data,
          createdAt: new Date(),
          updatedAt: new Date(),
          sellerOffer,
        }),
      ),
    },
  };
  const service = new CartService(prisma as never);
  return { service, prisma };
};

describe('CartService.addToCart — pre-order stock gate', () => {
  it('accepts an unlimited quantity on a pre-order with no batches at all', async () => {
    const { service, prisma } = buildAdd(preOrderOffer());

    const result = await service.addToCart('buyer-1', {
      sellerOfferId: 'offer-1',
      quantity: 50,
    } as never);

    expect(prisma.cartItem.create).toHaveBeenCalledTimes(1);
    expect(prisma.cartItem.create.mock.calls[0][0].data).toMatchObject({
      sellerOfferId: 'offer-1',
      quantity: 50,
    });
    expect(result.quantity).toBe(50);
  });

  it('still refuses an ordinary listing with no stock (no regression)', async () => {
    const { service, prisma } = buildAdd(offer());

    await expect(
      service.addToCart('buyer-1', {
        sellerOfferId: 'offer-1',
        quantity: 50,
      } as never),
    ).rejects.toThrow(/Insufficient stock/);
    expect(prisma.cartItem.create).not.toHaveBeenCalled();
  });

  it('still refuses an ordinary listing asking for more than its batches hold', async () => {
    const { service } = buildAdd(offer({ batches: [{ stock: 3 }] }));

    await expect(
      service.addToCart('buyer-1', {
        sellerOfferId: 'offer-1',
        quantity: 4,
      } as never),
    ).rejects.toThrow(/Insufficient stock. Only 3 units available/);
  });

  it('still enforces the per-order maximum on a pre-order — unlimited in total is not unlimited per order', async () => {
    const { service, prisma } = buildAdd(
      preOrderOffer({ maximumOrderQuantity: 5 }),
    );

    await expect(
      service.addToCart('buyer-1', {
        sellerOfferId: 'offer-1',
        quantity: 6,
      } as never),
    ).rejects.toThrow(/Maximum order quantity/);
    expect(prisma.cartItem.create).not.toHaveBeenCalled();
  });

  it('still enforces the per-order minimum on a pre-order', async () => {
    const { service, prisma } = buildAdd(
      preOrderOffer({ minimumOrderQuantity: 10 }),
    );

    await expect(
      service.addToCart('buyer-1', {
        sellerOfferId: 'offer-1',
        quantity: 9,
      } as never),
    ).rejects.toThrow(/Minimum order quantity/);
    expect(prisma.cartItem.create).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────
// updateCartItem
// ──────────────────────────────────────────────

const buildUpdate = (sellerOffer: any) => {
  const prisma = {
    cartItem: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'item-1',
        quantity: 1,
        unitPrice: 90,
        cart: { userId: 'buyer-1' },
        sellerOffer,
      }),
      update: jest.fn().mockImplementation(({ data }: any) =>
        Promise.resolve({
          id: 'item-1',
          unitPrice: 90,
          ...data,
          sellerOffer,
        }),
      ),
    },
  };
  const service = new CartService(prisma as never);
  return { service, prisma };
};

describe('CartService.updateCartItem — pre-order stock gate', () => {
  it('raises the quantity on a pre-order line far above its zero stock', async () => {
    const { service, prisma } = buildUpdate(preOrderOffer());

    const result = await service.updateCartItem('buyer-1', 'item-1', {
      quantity: 99,
    } as never);

    expect(prisma.cartItem.update).toHaveBeenCalledTimes(1);
    expect(prisma.cartItem.update.mock.calls[0][0].data).toEqual({
      quantity: 99,
    });
    expect(result.quantity).toBe(99);
  });

  it('still refuses the same raise on an ordinary line (no regression)', async () => {
    const { service, prisma } = buildUpdate(offer());

    await expect(
      service.updateCartItem('buyer-1', 'item-1', { quantity: 99 } as never),
    ).rejects.toThrow(/Insufficient stock/);
    expect(prisma.cartItem.update).not.toHaveBeenCalled();
  });

  it('still refuses a raise past the batches an ordinary line does have', async () => {
    const { service } = buildUpdate(offer({ batches: [{ stock: 2 }] }));

    await expect(
      service.updateCartItem('buyer-1', 'item-1', { quantity: 3 } as never),
    ).rejects.toThrow(/Insufficient stock. Only 2 units available/);
  });

  it('still enforces the per-order maximum on a pre-order line', async () => {
    const { service, prisma } = buildUpdate(
      preOrderOffer({ maximumOrderQuantity: 5 }),
    );

    await expect(
      service.updateCartItem('buyer-1', 'item-1', { quantity: 6 } as never),
    ).rejects.toThrow(/Maximum order quantity/);
    expect(prisma.cartItem.update).not.toHaveBeenCalled();
  });

  it('still refuses a raise on a pre-order whose listing was deactivated', async () => {
    const { service, prisma } = buildUpdate(preOrderOffer({ isActive: false }));

    await expect(
      service.updateCartItem('buyer-1', 'item-1', { quantity: 7 } as never),
    ).rejects.toThrow(/no longer available/);
    expect(prisma.cartItem.update).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────
// getCart — the pruning filter that DELETES rows
// ──────────────────────────────────────────────

const buildCart = (items: any[]) => {
  const prisma = {
    cart: {
      findUnique: jest.fn().mockResolvedValue({ id: 'cart-1', items }),
    },
    cartItem: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };
  const service = new CartService(prisma as never);
  return { service, prisma };
};

const line = (id: string, sellerOffer: any) => ({
  id,
  quantity: 1,
  unitPrice: 90,
  createdAt: new Date(),
  updatedAt: new Date(),
  sellerOffer,
});

describe('CartService.getCart — pre-order lines survive pruning', () => {
  it('keeps a pre-order line with no stock, and deletes nothing', async () => {
    const { service, prisma } = buildCart([
      line('item-preorder', preOrderOffer()),
    ]);

    const result = await service.getCart('buyer-1');

    expect(result.items.map((i: any) => i.id)).toEqual(['item-preorder']);
    expect(prisma.cartItem.deleteMany).not.toHaveBeenCalled();
  });

  it('still prunes and deletes an ordinary line with no stock (no regression)', async () => {
    const { service, prisma } = buildCart([line('item-oos', offer())]);

    const result = await service.getCart('buyer-1');

    expect(result.items).toHaveLength(0);
    expect(prisma.cartItem.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['item-oos'] } },
    });
  });

  it('still prunes a pre-order line whose listing was deactivated — pre-order exempts the stock reason only', async () => {
    const { service, prisma } = buildCart([
      line('item-inactive', preOrderOffer({ isActive: false })),
    ]);

    const result = await service.getCart('buyer-1');

    expect(result.items).toHaveLength(0);
    expect(prisma.cartItem.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['item-inactive'] } },
    });
  });

  it('still prunes a pre-order line whose listing was soft-deleted', async () => {
    const { service, prisma } = buildCart([
      line('item-deleted', preOrderOffer({ deletedAt: new Date() })),
    ]);

    await service.getCart('buyer-1');

    expect(prisma.cartItem.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['item-deleted'] } },
    });
  });

  it('still prunes a pre-order line whose master product went Draft', async () => {
    const { service, prisma } = buildCart([
      line(
        'item-draft-master',
        preOrderOffer({
          catalogProduct: { isActive: false, deletedAt: null, images: [] },
        }),
      ),
    ]);

    await service.getCart('buyer-1');

    expect(prisma.cartItem.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['item-draft-master'] } },
    });
  });

  it('keeps the pre-order line while pruning the ordinary out-of-stock one beside it', async () => {
    const { service, prisma } = buildCart([
      line('item-preorder', preOrderOffer({ id: 'offer-preorder' })),
      line('item-oos', offer({ id: 'offer-oos' })),
    ]);

    const result = await service.getCart('buyer-1');

    expect(result.items.map((i: any) => i.id)).toEqual(['item-preorder']);
    expect(prisma.cartItem.deleteMany).toHaveBeenCalledTimes(1);
    expect(prisma.cartItem.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['item-oos'] } },
    });
  });

  it("asks Prisma for preOrderDeliveryDate in the offer's own select block", async () => {
    // Guards the `select` half of this change, which the filter tests cannot
    // reach: drop the field from the query and a real pre-order arrives
    // without a date, reads as ordinary, and gets deleted.
    const { service, prisma } = buildCart([line('item-1', preOrderOffer())]);

    await service.getCart('buyer-1');

    const select =
      prisma.cart.findUnique.mock.calls[0][0].include.items.include.sellerOffer
        .select;
    expect(select.preOrderDeliveryDate).toBe(true);
  });

  it('deletes a pre-order line whose date never arrived — the cost of forgetting that select', async () => {
    // The same offer with the field absent rather than null, exactly as a
    // narrow select would hand it over. Documents why the assertion above
    // matters.
    const stripped: any = preOrderOffer();
    delete stripped.preOrderDeliveryDate;

    const { service, prisma } = buildCart([line('item-1', stripped)]);

    const result = await service.getCart('buyer-1');

    expect(result.items).toHaveLength(0);
    expect(prisma.cartItem.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['item-1'] } },
    });
  });
});
