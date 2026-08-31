import { ReviewsService } from './reviews.service';

describe('ReviewsService — admin/seller review filtering', () => {
  const build = (rows: unknown[] = [], seller: unknown = { id: 'seller-1' }) => {
    const prisma = {
      review: {
        findMany: jest.fn().mockResolvedValue(rows),
        count: jest.fn().mockResolvedValue(rows.length),
        aggregate: jest.fn().mockResolvedValue({ _avg: { rating: 4.25 }, _count: 4 }),
      },
      sellerProfile: { findUnique: jest.fn().mockResolvedValue(seller) },
    };
    return { service: new ReviewsService(prisma as never), prisma };
  };

  it('scopes a seller to reviews of THEIR listing, never a rival selling the same product', async () => {
    const { service, prisma } = build();

    await service.getSellerReviews('user-1', {});

    const where = prisma.review.findMany.mock.calls[0][0].where as Record<string, unknown>;
    // Must go through the purchased listing, not "products this seller sells".
    expect(where.sellerOffer).toEqual({ sellerId: 'seller-1' });
  });

  it('never returns buyer identity to a seller', async () => {
    const { service } = build([
      {
        id: 'r1',
        catalogProductId: 'p1',
        rating: 5,
        comment: 'great',
        images: [],
        createdAt: new Date(),
        catalogProduct: { id: 'p1', name: 'Goku', category: { id: 'c1', name: 'Figurines' } },
      },
    ]);

    const res = await service.getSellerReviews('user-1', {});

    expect(res.data[0]).not.toHaveProperty('userId');
    expect(res.data[0]).not.toHaveProperty('userName');
    expect(res.summary).toEqual({ average: 4.3, count: 4 });
  });

  it('admin seller filter also goes through the purchased listing', async () => {
    const { service, prisma } = build();

    await service.getAdminReviews({ sellerId: 'seller-9' });

    const where = prisma.review.findMany.mock.calls[0][0].where as Record<string, unknown>;
    expect(where.sellerOffer).toEqual({ sellerId: 'seller-9' });
  });

  it('admin category filter matches primary AND extra categories', async () => {
    const { service, prisma } = build();

    await service.getAdminReviews({ categoryId: 'cat-1' });

    const where = prisma.review.findMany.mock.calls[0][0].where as {
      catalogProduct: { OR: unknown[] };
    };
    expect(where.catalogProduct.OR).toHaveLength(2);
  });

  it('date range end is inclusive to end-of-day', async () => {
    const { service, prisma } = build();

    await service.getAdminReviews({ dateFrom: '2026-09-01', dateTo: '2026-09-05' });

    const where = prisma.review.findMany.mock.calls[0][0].where as {
      createdAt: { gte: Date; lte: Date };
    };
    expect(where.createdAt.lte.getHours()).toBe(23);
  });

  it('applies no filters when none are given (unchanged default listing)', async () => {
    const { service, prisma } = build();

    await service.getAdminReviews({});

    expect(prisma.review.findMany.mock.calls[0][0].where).toEqual({});
  });
});
