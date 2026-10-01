import { ProductsService } from './products.service';

/**
 * Buyer cards hydrate at most ONE offer per relation (`take: 1`, so the card
 * has a price without pulling every seller), which means the length of that
 * list is not the number of sellers. Reading sellerCount off it reported
 * "1 seller" for a product two sellers had listed — live, the grid said
 * sellerCount 1 while the product page returned two listings — and the admin
 * list's "+N other sellers" badge, gated on > 1, could never appear.
 */
describe('ProductsService sellerCount', () => {
  const service = new ProductsService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

  const mapGrid = (m: unknown) =>
    (service as never as { mapMasterToGrid: (m: unknown) => { sellerCount: number } })
      .mapMasterToGrid(m);

  const offer = (mrp: number) => ({ id: `offer-${mrp}`, mrp, batches: [] });

  it('counts sellers from the database, not from the capped offer list', () => {
    // What buyerGridInclude() actually returns for the two-seller product:
    // one hydrated offer (the cheapest) and a count of two.
    const master = {
      id: 'p1',
      mrp: 1599,
      sellerOffers: [offer(1599)],
      productVariants: [],
      _count: { sellerOffers: 2 },
    };

    expect(mapGrid(master).sellerCount).toBe(2);
  });

  it('adds offers reached through variants to those attached directly', () => {
    const master = {
      id: 'p1',
      sellerOffers: [offer(500)],
      productVariants: [
        { id: 'v1', name: 'Small', sellerOffers: [offer(500)], _count: { sellerOffers: 3 } },
        { id: 'v2', name: 'Large', sellerOffers: [offer(900)], _count: { sellerOffers: 1 } },
      ],
      _count: { sellerOffers: 2 },
    };

    expect(mapGrid(master).sellerCount).toBe(6);
  });

  it('falls back to the hydrated list when the caller counted nothing', () => {
    // getFeatured hydrates every offer and carries no _count. Reporting zero
    // there would strand featured products: the storefront treats
    // sellerCount === 0 as "not available".
    const master = {
      id: 'p1',
      sellerOffers: [offer(100), offer(200)],
      productVariants: [],
    };

    expect(mapGrid(master).sellerCount).toBe(2);
  });

  it('still reports no sellers for a product nobody lists', () => {
    const master = {
      id: 'p1',
      sellerOffers: [],
      productVariants: [],
      _count: { sellerOffers: 0 },
    };

    const card = mapGrid(master) as { sellerCount: number; hasSellers: boolean };
    expect(card.sellerCount).toBe(0);
    expect(card.hasSellers).toBe(false);
  });
});
