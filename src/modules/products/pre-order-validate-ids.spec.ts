import { ProductsService } from './products.service';

/**
 * validateIds backs POST /products/validate-ids, which the buyer app uses to
 * validate its local cart before checkout and to check saved items. A
 * pre-order offer has no tracked stock — quantity is unlimited — so the old
 * `.filter((o) => o.stock > 0)` silently dropped every pre-order, directly
 * contradicting the cart gates (which allow a pre-order line) and the
 * storefront (which keeps it in the bag). The fix widens the filter to admit
 * `isPreOrder(o)`, but that only works if `preOrderDeliveryDate` is actually
 * selected off the database row — see pre-order.util.ts's docstring on the
 * "absent key reads as null" trap. The last assertion in this file guards
 * against exactly that regression; a mock can't expose a missing `select`
 * column, only the shape of the query it was given.
 */
describe('ProductsService.validateIds and pre-order offers', () => {
  const makeService = (offers: unknown[]) => {
    const findMany = jest.fn().mockResolvedValue(offers);
    const prisma = { sellerOffer: { findMany } } as never;
    const service = new ProductsService(
      prisma,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { service, findMany };
  };

  it('returns a pre-order offer with no batches, carrying its delivery date', async () => {
    const { service } = makeService([
      {
        id: 'offer-preorder',
        mrp: 1000,
        finalCustomerPayable: 900,
        preOrderDeliveryDate: new Date('2026-12-25'),
        batches: [],
      },
    ]);

    const result = await service.validateIds(['offer-preorder']);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'offer-preorder',
      price: 900,
      mrp: 1000,
      stock: 0,
      preOrderDeliveryDate: new Date('2026-12-25'),
    });
  });

  it('still drops an ordinary offer with no batches (no regression)', async () => {
    const { service } = makeService([
      {
        id: 'offer-ordinary-empty',
        mrp: 500,
        finalCustomerPayable: null,
        preOrderDeliveryDate: null,
        batches: [],
      },
    ]);

    const result = await service.validateIds(['offer-ordinary-empty']);

    expect(result).toEqual([]);
  });

  it('still returns an ordinary offer with stock, with the right stock figure (no regression)', async () => {
    const { service } = makeService([
      {
        id: 'offer-ordinary-stocked',
        mrp: 200,
        finalCustomerPayable: 180,
        preOrderDeliveryDate: null,
        batches: [{ stock: 3 }, { stock: 5 }],
      },
    ]);

    const result = await service.validateIds(['offer-ordinary-stocked']);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'offer-ordinary-stocked',
      price: 180,
      mrp: 200,
      stock: 8,
      preOrderDeliveryDate: null,
    });
  });

  it('names preOrderDeliveryDate in the select passed to prisma.sellerOffer.findMany', async () => {
    const { service, findMany } = makeService([]);

    await service.validateIds(['some-id']);

    expect(findMany).toHaveBeenCalledTimes(1);
    const args = findMany.mock.calls[0][0] as { select?: Record<string, unknown> };
    expect(args.select).toBeDefined();
    expect(args.select).toHaveProperty('preOrderDeliveryDate', true);
  });
});
