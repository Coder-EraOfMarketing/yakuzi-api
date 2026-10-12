import { ProductsService } from './products.service';

/**
 * "Sort by: Price — Low to High" did nothing.
 *
 * findAll mapped sortBy=price onto CatalogProduct.mrp, the master's own list
 * price, which is NULL on nearly every row — so the ORDER BY was a no-op and
 * asc and desc returned byte-identical pages. It was the wrong number anyway:
 * the grid card prints the cheapest offer's computed final customer payable,
 * not the master's list price.
 *
 * Price now lives on the master as `lowestOfferPrice`, so the sort can happen
 * in SQL (required for pagination to mean anything), and these specs pin the
 * two halves of that: the value is computed from the right offers, and all
 * three findAll paths order by it the same way.
 */

// ──────────────────────────────────────────────────────────────────────────
// A fake offer table that actually evaluates the where clause.
//
// A structural assertion ("the where contains both branches") passes for code
// that builds the right filter and then ignores half of it. Interpreting the
// filter against fixture rows instead means a recompute that follows only one
// route from offer to master, or that forgets isActive/deletedAt, returns the
// wrong NUMBER — which is what a shopper would actually see.
// ──────────────────────────────────────────────────────────────────────────

type OfferRow = {
  id: string;
  isActive: boolean;
  deletedAt: Date | null;
  catalogProductId: string | null;
  variantId: string | null;
  finalCustomerPayable: number | null;
  mrp: number | null;
};

const offer = (over: Partial<OfferRow> & { id: string }): OfferRow => ({
  isActive: true,
  deletedAt: null,
  catalogProductId: null,
  variantId: null,
  finalCustomerPayable: null,
  mrp: null,
  ...over,
});

/** Only the shapes recalculateLowestOfferPrice is allowed to build. */
const matches = (
  row: OfferRow,
  where: any,
  variantOwner: Record<string, string>,
): boolean => {
  if ('isActive' in where && row.isActive !== where.isActive) return false;
  if ('deletedAt' in where) {
    const wantNull = where.deletedAt === null;
    if (wantNull !== (row.deletedAt === null)) return false;
  }
  if (Array.isArray(where.OR)) {
    const any = where.OR.some((branch: any) => {
      if ('catalogProductId' in branch) {
        return (
          row.catalogProductId !== null &&
          row.catalogProductId === branch.catalogProductId
        );
      }
      if (branch.variant) {
        return (
          row.variantId !== null &&
          variantOwner[row.variantId] === branch.variant.catalogProductId
        );
      }
      return false;
    });
    if (!any) return false;
  }
  return true;
};

const build = (opts: {
  offers?: OfferRow[];
  /** variantId -> the master that variant hangs off */
  variantOwner?: Record<string, string>;
  offerById?: Record<string, any>;
} = {}) => {
  const offers = opts.offers ?? [];
  const variantOwner = opts.variantOwner ?? {};

  const prisma = {
    sellerOffer: {
      findMany: jest.fn(({ where, select }: any) => {
        const rows = offers.filter((o) => matches(o, where, variantOwner));
        // Honour the projection, so a spec can never read a column the service
        // did not ask the database for.
        return Promise.resolve(
          rows.map((r) =>
            Object.fromEntries(
              Object.keys(select ?? {}).map((k) => [k, (r as any)[k]]),
            ),
          ),
        );
      }),
      findUnique: jest.fn(({ where }: any) =>
        Promise.resolve(opts.offerById?.[where.id] ?? null),
      ),
      update: jest.fn().mockResolvedValue({}),
    },
    catalogProduct: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      update: jest.fn().mockResolvedValue({}),
    },
    $executeRaw: jest.fn().mockResolvedValue(1),
  };

  const service = new ProductsService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

  /** The (price, masterId) pair the raw UPDATE was parameterised with. */
  const written = () => {
    const calls = prisma.$executeRaw.mock.calls;
    return calls.map((c) => ({ price: c[1], masterId: c[2] }));
  };

  return { service, prisma, written };
};

describe('recalculateLowestOfferPrice — the number the card prints', () => {
  it('takes the minimum across offers reached directly AND through a variant', async () => {
    // An offer reaches its master two ways. Following one route has already
    // caused three production bugs here (a wrong product photo on orders, a 0%
    // commission, a flat-5% settlement). The cheapest offer below is on the
    // VARIANT route and the second-cheapest is DIRECT, so dropping either
    // route changes the answer.
    const { service, written } = build({
      offers: [
        offer({ id: 'direct-dear', catalogProductId: 'M', finalCustomerPayable: 5000 }),
        offer({ id: 'direct-mid', catalogProductId: 'M', finalCustomerPayable: 3100 }),
        offer({ id: 'via-variant', variantId: 'V1', finalCustomerPayable: 2400 }),
      ],
      variantOwner: { V1: 'M' },
    });

    await service.recalculateLowestOfferPrice('M');

    expect(written()).toEqual([{ price: 2400, masterId: 'M' }]);
  });

  it('still finds the direct route when the cheapest offer is not on a variant', async () => {
    // The mirror of the case above: a recompute that walked only the variant
    // path would answer 2400 here instead of 900.
    const { service, written } = build({
      offers: [
        offer({ id: 'direct-cheap', catalogProductId: 'M', finalCustomerPayable: 900 }),
        offer({ id: 'via-variant', variantId: 'V1', finalCustomerPayable: 2400 }),
      ],
      variantOwner: { V1: 'M' },
    });

    await service.recalculateLowestOfferPrice('M');

    expect(written()).toEqual([{ price: 900, masterId: 'M' }]);
  });

  it('ignores offers belonging to another master, by either route', async () => {
    const { service, written } = build({
      offers: [
        offer({ id: 'ours', catalogProductId: 'M', finalCustomerPayable: 4000 }),
        offer({ id: 'theirs-direct', catalogProductId: 'OTHER', finalCustomerPayable: 10 }),
        offer({ id: 'theirs-variant', variantId: 'V9', finalCustomerPayable: 20 }),
      ],
      variantOwner: { V9: 'OTHER' },
    });

    await service.recalculateLowestOfferPrice('M');

    expect(written()).toEqual([{ price: 4000, masterId: 'M' }]);
  });

  it('excludes inactive and soft-deleted offers — a dead listing is not a price', async () => {
    const { service, written } = build({
      offers: [
        offer({ id: 'live', catalogProductId: 'M', finalCustomerPayable: 7000 }),
        offer({ id: 'disabled', catalogProductId: 'M', isActive: false, finalCustomerPayable: 11 }),
        offer({
          id: 'deleted',
          catalogProductId: 'M',
          deletedAt: new Date('2026-01-01'),
          finalCustomerPayable: 12,
        }),
        // Both routes have to respect sellability, not just the direct one.
        offer({ id: 'deleted-variant', variantId: 'V1', deletedAt: new Date('2026-01-01'), finalCustomerPayable: 13 }),
      ],
      variantOwner: { V1: 'M' },
    });

    await service.recalculateLowestOfferPrice('M');

    expect(written()).toEqual([{ price: 7000, masterId: 'M' }]);
  });

  it('prefers finalCustomerPayable over mrp — that is the figure on the card', async () => {
    // Live examples from the storefront: master 4800 displays 3974.02, 3500
    // displays 3606.20. mrp is not the number the shopper is quoted, so
    // sorting on it would order by something invisible.
    // The two orderings disagree on purpose: cheapest by mrp is 'b' (3500),
    // cheapest by what the shopper is actually charged is 'a' (3974.02).
    const { service, written } = build({
      offers: [
        offer({ id: 'a', catalogProductId: 'M', mrp: 4800, finalCustomerPayable: 3974.02 }),
        offer({ id: 'b', catalogProductId: 'M', mrp: 3500, finalCustomerPayable: 4100 }),
      ],
      variantOwner: {},
    });

    await service.recalculateLowestOfferPrice('M');

    expect(written()).toEqual([{ price: 3974.02, masterId: 'M' }]);
  });

  it('falls back to mrp for an offer whose payable has never been computed', async () => {
    const { service, written } = build({
      offers: [
        offer({ id: 'computed', catalogProductId: 'M', mrp: 9000, finalCustomerPayable: 8000 }),
        offer({ id: 'never-computed', catalogProductId: 'M', mrp: 2500, finalCustomerPayable: null }),
      ],
      variantOwner: {},
    });

    await service.recalculateLowestOfferPrice('M');

    expect(written()).toEqual([{ price: 2500, masterId: 'M' }]);
  });

  it('writes null when nobody is selling the product', async () => {
    // Null, not 0. "No sellers" is a different fact from "free", and findAll
    // sorts these rows last in both directions because of it.
    const { service, written } = build({
      offers: [
        offer({ id: 'gone', catalogProductId: 'M', isActive: false, finalCustomerPayable: 500 }),
      ],
      variantOwner: {},
    });

    await service.recalculateLowestOfferPrice('M');

    expect(written()).toEqual([{ price: null, masterId: 'M' }]);
  });

  it('writes null rather than 0 when the only live offer carries no price at all', async () => {
    const { service, written } = build({
      offers: [offer({ id: 'priceless', catalogProductId: 'M' })],
      variantOwner: {},
    });

    await service.recalculateLowestOfferPrice('M');

    expect(written()).toEqual([{ price: null, masterId: 'M' }]);
  });

  it('does not bump the master updatedAt — sortBy=newest must not track seller edits', async () => {
    // updatedAt is @updatedAt and is what sortBy=newest orders on. Writing
    // this derived cache through prisma.catalogProduct.update would shove a
    // product to the front of "Newest" every time a seller edited a price.
    const { service, prisma } = build({
      offers: [offer({ id: 'a', catalogProductId: 'M', finalCustomerPayable: 100 })],
      variantOwner: {},
    });

    await service.recalculateLowestOfferPrice('M');

    expect(prisma.catalogProduct.update).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
  });
});

describe('recalculateLowestOfferPriceForOffer — offer to master, both routes', () => {
  it('refreshes the master an offer points at directly', async () => {
    const { service, written } = build({
      offerById: { 'o1': { catalogProductId: 'M', variant: null } },
      offers: [offer({ id: 'o1', catalogProductId: 'M', finalCustomerPayable: 1234 })],
      variantOwner: {},
    });

    await service.recalculateLowestOfferPriceForOffer('o1');

    expect(written()).toEqual([{ price: 1234, masterId: 'M' }]);
  });

  it('refreshes the master reached through the offer variant', async () => {
    const { service, written } = build({
      offerById: {
        'o1': { catalogProductId: null, variant: { catalogProductId: 'M' } },
      },
      offers: [offer({ id: 'o1', variantId: 'V1', finalCustomerPayable: 777 })],
      variantOwner: { V1: 'M' },
    });

    await service.recalculateLowestOfferPriceForOffer('o1');

    expect(written()).toEqual([{ price: 777, masterId: 'M' }]);
  });

  it('refreshes the master once when both routes name the same one', async () => {
    const { service, written } = build({
      offerById: {
        'o1': { catalogProductId: 'M', variant: { catalogProductId: 'M' } },
      },
      offers: [offer({ id: 'o1', catalogProductId: 'M', finalCustomerPayable: 50 })],
      variantOwner: { V1: 'M' },
    });

    await service.recalculateLowestOfferPriceForOffer('o1');

    expect(written()).toHaveLength(1);
  });

  it('refreshes both masters when the two routes disagree', async () => {
    const { service, written } = build({
      offerById: {
        'o1': { catalogProductId: 'M1', variant: { catalogProductId: 'M2' } },
      },
      offers: [offer({ id: 'o1', catalogProductId: 'M1', variantId: 'V2', finalCustomerPayable: 60 })],
      variantOwner: { V2: 'M2' },
    });

    await service.recalculateLowestOfferPriceForOffer('o1');

    expect(written().map((w) => w.masterId).sort()).toEqual(['M1', 'M2']);
  });

  it('is a no-op for an offer that no longer exists', async () => {
    const { service, prisma } = build({ offerById: {} });

    await service.recalculateLowestOfferPriceForOffer('gone');

    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });
});

describe('recalculateFinalCustomerPayable also refreshes its master', () => {
  it('recomputes the master lowest price after writing an offer payable', async () => {
    // This is the hook that covers all eight offer-write call sites: anything
    // that can change an offer's price comes through here.
    const { service, prisma } = build({
      offerById: {
        'o1': {
          id: 'o1',
          mrp: 1000,
          gstPercent: 0,
          isTaxIncluded: true,
          shippingCharges: 0,
          finalShippingPrice: 0,
          discountType: null,
          discountMeta: null,
          catalogProductId: 'M',
          variant: null,
        },
      },
      offers: [offer({ id: 'o1', catalogProductId: 'M', finalCustomerPayable: 1000 })],
      variantOwner: {},
    });

    await service.recalculateFinalCustomerPayable('o1');

    expect(prisma.sellerOffer.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'o1' } }),
    );
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
  });
});

describe('findAll — sortBy=price orders on lowestOfferPrice, nulls last', () => {
  const expected = (sort: 'asc' | 'desc') => ({
    lowestOfferPrice: { sort, nulls: 'last' },
  });

  it('orders the plain browse path on lowestOfferPrice ascending', async () => {
    const { service, prisma } = build();

    await service.findAll({ sortBy: 'price', sortOrder: 'asc' } as never);

    expect(prisma.catalogProduct.findMany.mock.calls[0][0].orderBy).toEqual(
      expected('asc'),
    );
  });

  it('puts nulls last on descending too — an unsold product must not head the list', async () => {
    // Postgres defaults NULLs FIRST on DESC, which would open "Price: High to
    // Low" with every product nobody sells.
    const { service, prisma } = build();

    await service.findAll({ sortBy: 'price', sortOrder: 'desc' } as never);

    expect(prisma.catalogProduct.findMany.mock.calls[0][0].orderBy).toEqual(
      expected('desc'),
    );
  });

  it('orders the search-union path the same way', async () => {
    // An explicit sort outranks relevance, so search collapses to one query
    // over the union of the buckets.
    const { service, prisma } = build();

    await service.findAll({
      search: 'goku',
      sortBy: 'price',
      sortOrder: 'asc',
    } as never);

    expect(prisma.catalogProduct.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.catalogProduct.findMany.mock.calls[0][0].orderBy).toEqual(
      expected('asc'),
    );
  });

  it('gives every bucket of the relevance path the one shared ordering object', async () => {
    // The third path. It is only reachable when query.sortBy is ABSENT — with
    // an explicit sort, search collapses to the union query above — so
    // sortBy=price can never arrive here while that remains true. What this
    // pins instead is that all three bucket queries receive the *same object*
    // the other two paths are built from, by reference. That is what stops the
    // three sites drifting apart again: there is only one ordering to drift.
    const { service, prisma } = build();
    jest
      .spyOn(
        service as never as { mapMasterToGrid: (m: unknown) => unknown },
        'mapMasterToGrid',
      )
      .mockImplementation((m) => m);
    prisma.catalogProduct.count
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1);
    prisma.catalogProduct.findMany
      .mockResolvedValueOnce([{ id: 'n1' }])
      .mockResolvedValueOnce([{ id: 'c1' }])
      .mockResolvedValueOnce([{ id: 'd1' }]);

    await service.findAll({ search: 'goku', limit: 20 } as never);

    const orderBys = prisma.catalogProduct.findMany.mock.calls.map(
      (c: any[]) => c[0].orderBy,
    );
    expect(orderBys).toHaveLength(3);
    // Identity, not equality: all three buckets read the one orderBy.
    expect(orderBys[1]).toBe(orderBys[0]);
    expect(orderBys[2]).toBe(orderBys[0]);
    expect(orderBys[0]).toEqual({ createdAt: 'desc' });
  });

  it('leaves non-price sorts as a plain column order', async () => {
    const { service, prisma } = build();

    await service.findAll({ sortBy: 'newest', sortOrder: 'desc' } as never);

    expect(prisma.catalogProduct.findMany.mock.calls[0][0].orderBy).toEqual({
      updatedAt: 'desc',
    });
  });

  it('never orders on CatalogProduct.mrp for sortBy=price — that column is empty in practice', async () => {
    const { service, prisma } = build();

    await service.findAll({ sortBy: 'price', sortOrder: 'asc' } as never);

    const orderBy = prisma.catalogProduct.findMany.mock.calls[0][0].orderBy;
    expect(Object.keys(orderBy)).not.toContain('mrp');
  });
});
