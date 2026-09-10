import { WishlistService } from './wishlist.service';

/**
 * The wishlist lived only in one browser. Moving it to the server means it has
 * to survive the things a saved list runs into: the same item saved twice, an
 * item removed that was never there, and a listing that has since been
 * delisted — none of which may surface as an error on a bookmark button.
 */
describe('WishlistService', () => {
  const USER = 'user-1';
  const OFFER = 'offer-1';

  const build = (over: {
    rows?: Array<{ id: string; productId: string; createdAt: Date }>;
    offers?: unknown[];
    catalogProducts?: unknown[];
  } = {}) => {
    const prisma = {
      wishlistItem: {
        findMany: jest.fn().mockResolvedValue(over.rows ?? []),
        upsert: jest.fn().mockResolvedValue({
          id: 'w1',
          productId: OFFER,
          createdAt: new Date('2026-09-11T10:00:00Z'),
        }),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
      sellerOffer: { findMany: jest.fn().mockResolvedValue(over.offers ?? []) },
      catalogProduct: {
        findMany: jest.fn().mockResolvedValue(over.catalogProducts ?? []),
      },
    };
    return { service: new WishlistService(prisma as never), prisma };
  };

  const row = (productId = OFFER) => ({
    id: 'w1',
    productId,
    createdAt: new Date('2026-09-11T10:00:00Z'),
  });

  const offer = (id = OFFER) => ({
    id,
    name: 'Iron Man Helmet',
    manufacturer: 'Marvel',
    mrp: 16999,
    finalCustomerPayable: 15394.68,
    variant: {
      catalogProduct: {
        slug: 'iron-man-helmet',
        images: [{ url: 'https://cdn/img1.jpg' }],
      },
    },
  });

  it('returns saved items with what a buyer would actually pay', async () => {
    const { service } = build({ rows: [row()], offers: [offer()] });

    const result = await service.list(USER);

    expect(result.total).toBe(1);
    expect(result.items[0].product).toMatchObject({
      id: OFFER,
      name: 'Iron Man Helmet',
      price: 15394.68, // finalCustomerPayable, not the MRP
      mrp: 16999,
      slug: 'iron-man-helmet',
    });
    expect(result.items[0].product?.images).toEqual(['https://cdn/img1.jpg']);
  });

  it('falls back to the listed price when there is no final payable', async () => {
    const { service } = build({
      rows: [row()],
      offers: [{ ...offer(), finalCustomerPayable: null }],
    });

    const result = await service.list(USER);

    expect(result.items[0].product?.price).toBe(16999);
  });

  it('drops an item whose listing no longer exists rather than showing a blank card', async () => {
    const { service } = build({ rows: [row('gone')], offers: [], catalogProducts: [] });

    const result = await service.list(USER);

    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('resolves an older entry that holds a catalog product id', async () => {
    const { service } = build({
      rows: [row('catalog-1')],
      offers: [],
      catalogProducts: [
        { id: 'catalog-1', name: 'Naruto Figure', slug: 'naruto', images: [] },
      ],
    });

    const result = await service.list(USER);

    expect(result.items[0].product?.name).toBe('Naruto Figure');
  });

  it('does not query the database at all for an empty wishlist', async () => {
    const { service, prisma } = build({ rows: [] });

    const result = await service.list(USER);

    expect(result).toEqual({ items: [], total: 0 });
    expect(prisma.sellerOffer.findMany).not.toHaveBeenCalled();
  });

  it('still returns the list when product resolution fails', async () => {
    const { service, prisma } = build({ rows: [row()] });
    prisma.sellerOffer.findMany.mockRejectedValue(new Error('db down'));

    await expect(service.list(USER)).resolves.toEqual({ items: [], total: 0 });
  });

  it('treats saving the same item twice as a no-op, not an error', async () => {
    const { service, prisma } = build();

    await service.add(USER, OFFER);

    expect(prisma.wishlistItem.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_productId: { userId: USER, productId: OFFER } },
        update: {},
      }),
    );
  });

  it('removes by product id, which is what the storefront holds', async () => {
    const { service, prisma } = build();

    const result = await service.remove(USER, OFFER);

    expect(prisma.wishlistItem.deleteMany).toHaveBeenCalledWith({
      where: { userId: USER, productId: OFFER },
    });
    expect(result).toEqual({ removed: 1 });
  });

  it('succeeds when removing something that was never saved', async () => {
    const { service, prisma } = build();
    prisma.wishlistItem.deleteMany.mockResolvedValue({ count: 0 });

    await expect(service.remove(USER, 'never-saved')).resolves.toEqual({ removed: 0 });
  });

  it('merges a browser list without duplicating what is already saved', async () => {
    const { service, prisma } = build();

    await service.merge(USER, ['a', 'b', 'a', '  ', 'b']);

    const args = prisma.wishlistItem.createMany.mock.calls[0][0];
    expect(args.skipDuplicates).toBe(true);
    expect(args.data).toEqual([
      { userId: USER, productId: 'a' },
      { userId: USER, productId: 'b' },
    ]);
  });

  it('never removes anything on merge — an offline device must not delete saves', async () => {
    const { service, prisma } = build();

    await service.merge(USER, ['a']);

    expect(prisma.wishlistItem.deleteMany).not.toHaveBeenCalled();
  });

  it('ignores an empty merge without touching the database', async () => {
    const { service, prisma } = build();

    await expect(service.merge(USER, [])).resolves.toEqual({ added: 0 });
    expect(prisma.wishlistItem.createMany).not.toHaveBeenCalled();
  });

  it('caps a merge so one browser cannot write an unbounded list', async () => {
    const { service, prisma } = build();

    await service.merge(USER, Array.from({ length: 500 }, (_, i) => `p${i}`));

    expect(prisma.wishlistItem.createMany.mock.calls[0][0].data).toHaveLength(200);
  });
});
