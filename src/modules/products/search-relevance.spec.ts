import { ProductsService } from './products.service';

describe('ProductsService.findAll ranked search', () => {
  const prisma = {
    catalogProduct: {
      count: jest.fn(),
      findMany: jest.fn(),
    },
  };

  const service = new ProductsService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    // The grid mapper needs fully hydrated rows; identity keeps the spec on
    // the ranking/pagination logic itself.
    jest
      .spyOn(service as never as { mapMasterToGrid: (m: unknown) => unknown }, 'mapMasterToGrid')
      .mockImplementation((m) => m);
  });

  const row = (id: string) => ({ id });

  it('orders results name-bucket first, then category, then description', async () => {
    prisma.catalogProduct.count
      .mockResolvedValueOnce(2) // name matches
      .mockResolvedValueOnce(1) // category matches
      .mockResolvedValueOnce(1); // description matches
    prisma.catalogProduct.findMany
      .mockResolvedValueOnce([row('name-1'), row('name-2')])
      .mockResolvedValueOnce([row('cat-1')])
      .mockResolvedValueOnce([row('desc-1')]);

    const result = await service.findAll({ search: 'goku', limit: 20 } as never);

    expect(result.products.map((p: { id: string }) => p.id)).toEqual([
      'name-1',
      'name-2',
      'cat-1',
      'desc-1',
    ]);
    expect(result.meta.total).toBe(4);
  });

  it('keeps the buckets disjoint so a product cannot appear twice', async () => {
    prisma.catalogProduct.count.mockResolvedValue(0);

    await service.findAll({ search: 'goku' } as never);

    const [w1, w2, w3] = prisma.catalogProduct.count.mock.calls.map(
      (c) => c[0].where,
    );
    // bucket 2 excludes bucket 1's condition; bucket 3 excludes both
    expect(JSON.stringify(w1)).not.toContain('NOT');
    expect(w2.AND.filter((x: object) => 'NOT' in x)).toHaveLength(1);
    expect(w3.AND.filter((x: object) => 'NOT' in x)).toHaveLength(2);
  });

  it('translates a page that starts inside a later bucket', async () => {
    prisma.catalogProduct.count
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(4);
    prisma.catalogProduct.findMany.mockResolvedValueOnce([row('desc-2')]);

    // page 2 with limit 5 -> global offset 5 = past name(3) and category(2)
    const result = await service.findAll({
      search: 'goku',
      page: 2,
      limit: 5,
    } as never);

    expect(prisma.catalogProduct.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.catalogProduct.findMany.mock.calls[0][0]).toMatchObject({
      skip: 0,
      take: 5,
    });
    expect(result.meta.total).toBe(9);
  });

  it('a page can straddle a bucket boundary', async () => {
    prisma.catalogProduct.count
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(0);
    prisma.catalogProduct.findMany
      .mockResolvedValueOnce([row('name-3')]) // bucket 1, skip 2 -> 1 row left
      .mockResolvedValueOnce([row('cat-1')]); // bucket 2, take 1

    // limit 3, page 2 -> offset 3... use limit 3 page 1 offset 0? For straddle: limit 3, offset 2
    const result = await service.findAll({
      search: 'goku',
      page: 2,
      limit: 2,
    } as never); // offset 2: bucket1 has 3 -> take name row 3, then 1 more from bucket 2

    expect(prisma.catalogProduct.findMany.mock.calls[0][0]).toMatchObject({
      skip: 2,
      take: 2,
    });
    expect(prisma.catalogProduct.findMany.mock.calls[1][0]).toMatchObject({
      skip: 0,
      take: 1,
    });
    expect(result.products.map((p: { id: string }) => p.id)).toEqual([
      'name-3',
      'cat-1',
    ]);
  });

  it('an explicit user sort searches the union in that order instead of ranking', async () => {
    prisma.catalogProduct.findMany.mockResolvedValueOnce([row('a')]);
    prisma.catalogProduct.count.mockResolvedValueOnce(1);

    await service.findAll({ search: 'goku', sortBy: 'price' } as never);

    expect(prisma.catalogProduct.findMany).toHaveBeenCalledTimes(1);
    const arg = prisma.catalogProduct.findMany.mock.calls[0][0];
    // 'price' maps to lowestOfferPrice, the denormalised cheapest live offer.
    // It used to map to CatalogProduct.mrp — the master's own list price, null
    // on nearly every row, which made the sort a no-op.
    expect(arg.orderBy).toEqual({
      lowestOfferPrice: { sort: 'desc', nulls: 'last' },
    });
    expect(JSON.stringify(arg.where)).toContain('description');
  });
});
