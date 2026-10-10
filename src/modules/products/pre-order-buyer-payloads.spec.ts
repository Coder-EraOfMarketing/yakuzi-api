import { Prisma } from '@prisma/client';
import { ProductsService } from './products.service';

/**
 * A pre-order listing has no batch stock, so every buyer-facing payload
 * reports `stock: 0` for one — truthfully. `stock: 0` alone, though, is
 * indistinguishable from sold out, and the storefront renders it unavailable.
 * The date is the only thing that tells the two apart (the apps' rule is
 * `isPreOrder(listing) || stock > 0`), so the grid, the detail payload and the
 * featured rails all have to carry it.
 *
 * Half of these tests assert the QUERY and not the response, because a mapper
 * can only emit what its query fetched and a narrow `select` that forgets the
 * column fails silently: `isPreOrder` reads an absent key exactly as it reads a
 * stored null, so the payload says "no pre-orders exist" rather than throwing.
 * The cart work proved this empirically — six behavioural tests stayed green
 * with the `select` line deleted, because a mocked Prisma returns whatever
 * shape the test built, and only the query-shape assertion caught it.
 */

const PRE_ORDER_DATE = new Date('2026-12-15T00:00:00.000Z');
const OTHER_DATE = new Date('2027-03-01T00:00:00.000Z');

const service = new ProductsService(
  {} as never,
  {} as never,
  {} as never,
  {} as never,
  {} as never,
);

const mapGrid = (m: unknown) =>
  (
    service as never as {
      mapMasterToGrid: (m: unknown) => {
        stock: number;
        preOrderDeliveryDate: Date | null;
      };
    }
  ).mapMasterToGrid(m);

const detail = (m: unknown, sellerListing?: unknown) =>
  (
    service as never as {
      formatMasterDetail: (m: unknown, s?: unknown) => any;
    }
  ).formatMasterDetail(m, sellerListing);

/** An ordinary listing: real batch stock, no promised date. */
const offer = (overrides: Record<string, unknown> = {}) => ({
  id: 'offer-1',
  mrp: 500,
  batches: [{ stock: 7, expiryDate: null }],
  preOrderDeliveryDate: null,
  ...overrides,
});

/** A pre-order listing: no batches at all, and a date. */
const preOrder = (overrides: Record<string, unknown> = {}) =>
  offer({ batches: [], preOrderDeliveryDate: PRE_ORDER_DATE, ...overrides });

describe('mapMasterToGrid carries the pre-order date onto the card', () => {
  it('emits the date for a pre-order product, and still reports stock 0', () => {
    const card = mapGrid({
      id: 'p1',
      sellerOffers: [preOrder()],
      productVariants: [],
    });

    expect(card.preOrderDeliveryDate).toEqual(PRE_ORDER_DATE);
    // `stock: 0` is the truth and must stay: a sentinel would break the
    // storefront's `stock === 0` checks in the other direction.
    expect(card.stock).toBe(0);
  });

  it('emits null for an ordinary product', () => {
    const card = mapGrid({
      id: 'p1',
      sellerOffers: [offer()],
      productVariants: [],
    });

    expect(card.preOrderDeliveryDate).toBeNull();
    expect(card.stock).toBe(7);
  });

  it('emits null for a product nobody lists', () => {
    expect(
      mapGrid({ id: 'p1', sellerOffers: [], productVariants: [] })
        .preOrderDeliveryDate,
    ).toBeNull();
  });

  it('takes the date off the offer the card quotes, not off any offer', () => {
    // The card shows the cheapest offer's price and stock. If the date came
    // from somewhere else, an in-stock card would advertise a delivery promise
    // that belongs to a different seller.
    const card = mapGrid({
      id: 'p1',
      sellerOffers: [
        offer({ id: 'cheap', mrp: 100 }),
        preOrder({ id: 'dear', mrp: 900 }),
      ],
      productVariants: [],
    });

    expect(card.preOrderDeliveryDate).toBeNull();
    expect(card.stock).toBe(7);
  });

  it('emits the date when the quoted offer is the pre-order one', () => {
    const card = mapGrid({
      id: 'p1',
      sellerOffers: [
        preOrder({ id: 'cheap', mrp: 100 }),
        offer({ id: 'dear', mrp: 900 }),
      ],
      productVariants: [],
    });

    expect(card.preOrderDeliveryDate).toEqual(PRE_ORDER_DATE);
    expect(card.stock).toBe(0);
  });

  it('emits the date for an offer reached through a variant', () => {
    // collectListings() prefers the variant copy of an offer, so this is the
    // path a variant product's card actually takes.
    const card = mapGrid({
      id: 'p1',
      sellerOffers: [],
      productVariants: [
        { id: 'v1', name: 'Small', sellerOffers: [preOrder({ id: 'v-offer' })] },
      ],
    });

    expect(card.preOrderDeliveryDate).toEqual(PRE_ORDER_DATE);
  });
});

describe('formatMasterDetail carries the pre-order date onto the product page', () => {
  const master = (offers: unknown[], variants: unknown[] = []) => ({
    id: 'p1',
    name: 'Thing',
    sellerOffers: offers,
    productVariants: variants,
    images: [],
  });

  it('emits the date at the top level and on the listing entry', () => {
    const payload = detail(master([preOrder()]));

    expect(payload.preOrderDeliveryDate).toEqual(PRE_ORDER_DATE);
    expect(payload.listings).toHaveLength(1);
    expect(payload.listings[0].preOrderDeliveryDate).toEqual(PRE_ORDER_DATE);
    expect(payload.listings[0].stock).toBe(0);
  });

  it('emits null at both places for an ordinary listing', () => {
    const payload = detail(master([offer()]));

    expect(payload.preOrderDeliveryDate).toBeNull();
    expect(payload.listings[0].preOrderDeliveryDate).toBeNull();
  });

  it('gives every listing entry its OWN date', () => {
    // The seller picker swaps between these entries and reads price, stock,
    // seller and the date off whichever one is selected, so a single shared
    // top-level date would mislabel the others.
    const payload = detail(
      master([
        offer({ id: 'a', mrp: 100 }),
        preOrder({ id: 'b', mrp: 200 }),
        preOrder({ id: 'c', mrp: 300, preOrderDeliveryDate: OTHER_DATE }),
      ]),
    );

    expect(
      payload.listings.map((l: any) => [l.id, l.preOrderDeliveryDate]),
    ).toEqual([
      ['a', null],
      ['b', PRE_ORDER_DATE],
      ['c', OTHER_DATE],
    ]);
  });

  it('quotes the named listing at the top level, not the cheapest one', () => {
    // /products/:offerId passes the listing the URL named. Falling back to the
    // cheapest listing's date here would pair this ordinary listing's stock
    // with a promise no one made.
    const payload = detail(
      master([preOrder({ id: 'cheap', mrp: 100 })]),
      offer({ id: 'named', mrp: 900 }),
    );

    expect(payload.preOrderDeliveryDate).toBeNull();
  });

  it('emits the named listing’s own date when it is the pre-order', () => {
    const payload = detail(
      master([offer({ id: 'cheap', mrp: 100 })]),
      preOrder({ id: 'named', mrp: 900 }),
    );

    expect(payload.preOrderDeliveryDate).toEqual(PRE_ORDER_DATE);
    expect(payload.stock).toBe(0);
  });

  it('emits the date on the variant entry, whose `available` is honestly 0', () => {
    const payload = detail(
      master([], [
        {
          id: 'v1',
          name: 'Small',
          sellerOffers: [preOrder({ id: 'v-offer', mrp: 100 })],
        },
        {
          id: 'v2',
          name: 'Large',
          sellerOffers: [offer({ id: 'v-offer-2', mrp: 200 })],
        },
      ]),
    );

    expect(payload.variants[0].preOrderDeliveryDate).toEqual(PRE_ORDER_DATE);
    expect(payload.variants[0].available).toBe('0');
    expect(payload.variants[1].preOrderDeliveryDate).toBeNull();
  });

  /**
   * `mrp` is a Prisma Decimal in production, never a plain number, and a
   * Decimal's valueOf() returns a STRING — so `<` between two of them compares
   * lexicographically and `new Decimal('100') < new Decimal('90')` is true.
   * The variant entry has to pick the offer that set `price` (`Math.min`, which
   * coerces), so its comparison coerces too. These cases are the only place in
   * the repo where Decimal `mrp` is exercised; with plain numbers, or with a
   * single-offer variant (a one-element `reduce` with no seed returns that
   * element WITHOUT running the callback), the coercion has no coverage at all.
   */
  describe('with real Decimal prices, the variant date follows the priced offer', () => {
    const variant = (offers: unknown[]) => ({
      id: 'v1',
      name: 'Small',
      sellerOffers: offers,
    });
    const dec = (v: string) => new Prisma.Decimal(v);

    it('emits null when the dearer of the two is the pre-order', () => {
      // ₹90 is the price shown, and it is an ordinary in-stock listing.
      // Comparing the Decimals raw would read '100' <= '90' as true and pick
      // the ₹100 pre-order, advertising a delivery date on a ₹90 listing.
      const payload = detail(
        master([], [
          variant([
            preOrder({ id: 'dear-preorder', mrp: dec('100') }),
            offer({ id: 'cheap-ordinary', mrp: dec('90') }),
          ]),
        ]),
      );

      expect(payload.variants[0].price).toBe('90');
      expect(payload.variants[0].preOrderDeliveryDate).toBeNull();
      // The batch total spans every offer on the variant, so it is positive
      // here even though the pre-order contributes nothing.
      expect(payload.variants[0].available).toBe('7');
    });

    it('emits the date when the cheaper of the two is the pre-order', () => {
      const payload = detail(
        master([], [
          variant([
            offer({ id: 'dear-ordinary', mrp: dec('100') }),
            preOrder({ id: 'cheap-preorder', mrp: dec('90') }),
          ]),
        ]),
      );

      expect(payload.variants[0].price).toBe('90');
      expect(payload.variants[0].preOrderDeliveryDate).toEqual(PRE_ORDER_DATE);
    });

    it('breaks a price tie by keeping the first offer (pinning today’s behaviour)', () => {
      // Two listings at ₹90, one a pre-order. `<=` keeps the accumulator, so
      // the first offer in the list wins. Nothing depends on which — this
      // pins it so a later `<`/`<=` edit is a visible decision, not a drift.
      const first = detail(
        master([], [
          variant([
            preOrder({ id: 'tie-preorder', mrp: dec('90') }),
            offer({ id: 'tie-ordinary', mrp: dec('90') }),
          ]),
        ]),
      );
      const second = detail(
        master([], [
          variant([
            offer({ id: 'tie-ordinary', mrp: dec('90') }),
            preOrder({ id: 'tie-preorder', mrp: dec('90') }),
          ]),
        ]),
      );

      expect(first.variants[0].preOrderDeliveryDate).toEqual(PRE_ORDER_DATE);
      expect(second.variants[0].preOrderDeliveryDate).toBeNull();
    });
  });
});

/**
 * Does this Prisma relation block actually bring the column back?
 *
 * Two shapes are acceptable and the difference matters. A `select` lists the
 * columns it wants, so it has to name this one. An `include` (or no projection
 * at all) returns every scalar, so the column arrives unnamed — but narrowing
 * such a block to a `select` later is an ordinary-looking optimisation that
 * would silently drop the date, which is exactly what this asserts against.
 */
const expectFetchesPreOrderDate = (block: any) => {
  expect(block).toBeDefined();
  if (block.select) {
    expect(block.select.preOrderDeliveryDate).toBe(true);
  } else {
    expect(block.include).toBeDefined();
    expect(block.omit?.preOrderDeliveryDate).toBeFalsy();
  }
};

describe('the buyer-facing queries ask Prisma for preOrderDeliveryDate', () => {
  it('names the column in buyerGridInclude’s direct sellerOffers select', () => {
    const include = (
      service as never as { buyerGridInclude: () => any }
    ).buyerGridInclude();

    expect(include.sellerOffers.select.preOrderDeliveryDate).toBe(true);
  });

  it('names the column in buyerGridInclude’s sellerOffers under productVariants', () => {
    // Two near-identical blocks, and the variant one is the copy
    // collectListings() prefers — so a card can quote an offer fetched only
    // through here.
    const include = (
      service as never as { buyerGridInclude: () => any }
    ).buyerGridInclude();

    expect(
      include.productVariants.include.sellerOffers.select.preOrderDeliveryDate,
    ).toBe(true);
  });

  it('fetches the column in both of getFeatured’s offer blocks', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const featuredService = new ProductsService(
      { marketingProduct: { findMany } } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await featuredService.getFeatured('HOME_TOP');

    const product = findMany.mock.calls[0][0].include.catalogProduct.include;
    expectFetchesPreOrderDate(product.sellerOffers);
    expectFetchesPreOrderDate(product.productVariants.include.sellerOffers);
  });

  it('fetches the column on both queries of findOne’s offerId branch', async () => {
    // /products/:offerId resolves the named listing first and then its master.
    // The slug fallback below exercises a near-identical master query, but NOT
    // these two — so without this case, narrowing either to a `select` would
    // null the date on the branch whose top-level ternary quotes the named
    // listing, with every other test in this file still green.
    const offerFindFirst = jest.fn().mockResolvedValue({
      id: 'offer-named',
      catalogProductId: 'p1',
      mrp: 900,
      batches: [],
      preOrderDeliveryDate: OTHER_DATE,
    });
    const catalogFindFirst = jest.fn().mockResolvedValue({
      id: 'p1',
      name: 'Thing',
      images: [],
      sellerOffers: [preOrder({ id: 'offer-cheap', mrp: 100 })],
      productVariants: [],
    });
    const branchService = new ProductsService(
      {
        sellerOffer: { findFirst: offerFindFirst },
        catalogProduct: { findFirst: catalogFindFirst },
        review: {
          aggregate: jest
            .fn()
            .mockResolvedValue({ _count: 0, _avg: { rating: null } }),
        },
      } as never,
      {} as never,
      {} as never,
      { recordView: jest.fn() } as never,
      {} as never,
    );

    const payload: any = await branchService.findOne('offer-named');

    // The named listing itself is the root of the first query.
    expectFetchesPreOrderDate(offerFindFirst.mock.calls[0][0]);
    const include = catalogFindFirst.mock.calls[0][0].include;
    expectFetchesPreOrderDate(include.sellerOffers);
    expectFetchesPreOrderDate(include.productVariants.include.sellerOffers);
    // End to end: the named listing answers for itself, and the master's
    // cheaper pre-order (a different date) does not leak into the top level.
    expect(payload.preOrderDeliveryDate).toEqual(OTHER_DATE);
    expect(payload.listings[0].preOrderDeliveryDate).toEqual(PRE_ORDER_DATE);
  });

  it('fetches the column in both offer blocks of the product detail query', async () => {
    const catalogFindFirst = jest.fn().mockResolvedValue({
      id: 'p1',
      name: 'Thing',
      images: [],
      sellerOffers: [preOrder()],
      productVariants: [],
    });
    const detailService = new ProductsService(
      {
        sellerOffer: { findFirst: jest.fn().mockResolvedValue(null) },
        catalogProduct: { findFirst: catalogFindFirst },
        review: {
          aggregate: jest
            .fn()
            .mockResolvedValue({ _count: 0, _avg: { rating: null } }),
        },
      } as never,
      {} as never,
      {} as never,
      { recordView: jest.fn() } as never,
      {} as never,
    );

    const payload: any = await detailService.findOne('p1');

    const include = catalogFindFirst.mock.calls[0][0].include;
    expectFetchesPreOrderDate(include.sellerOffers);
    expectFetchesPreOrderDate(include.productVariants.include.sellerOffers);
    // And end to end, through the real query shape rather than a hand-built row.
    expect(payload.preOrderDeliveryDate).toEqual(PRE_ORDER_DATE);
    expect(payload.listings[0].preOrderDeliveryDate).toEqual(PRE_ORDER_DATE);
  });
});
