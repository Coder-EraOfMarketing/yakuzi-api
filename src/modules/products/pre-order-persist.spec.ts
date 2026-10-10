import { ProductsService } from './products.service';

/**
 * The seller form sends `stock: 0` for a pre-order listing — the input is
 * disabled, and the DTO requires the field, so something has to go in it.
 * Letting that 0 reach the DEFAULT batch would overwrite the real figure the
 * seller had, and untoggling pre-order would bring them back to an empty
 * shelf. The batch must be left alone and ignored while the date is set.
 *
 * The tri-state matters: an explicit `null` means "pre-order off", and the
 * stock write SHOULD run then. A naive `if (dto.preOrderDeliveryDate)` guard
 * gets cases 2 and 3 wrong in opposite directions.
 */
describe('ProductsService pre-order persistence and stock guards', () => {
  const build = (stored: { preOrderDeliveryDate: Date | null }) => {
    const updateDefaultBatch = jest.fn();
    const offer = { id: 'offer-1', sellerId: 'seller-1', ...stored };
    const prisma = {
      sellerProfile: { findUnique: jest.fn().mockResolvedValue({ id: 'seller-1', selfShipEnabled: true }) },
      sellerOffer: {
        findFirst: jest.fn().mockResolvedValue(offer),
        findUnique: jest.fn().mockResolvedValue({ ...offer, variant: null }),
        update: jest.fn().mockResolvedValue({ id: 'offer-1' }),
      },
      catalogProduct: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      productBatch: { findFirst: jest.fn().mockResolvedValue(null) },
      category: { findUnique: jest.fn().mockResolvedValue({ id: 'cat-1', name: 'Figures' }) },
      subCategory: { findUnique: jest.fn().mockResolvedValue({ id: 'sub-1', name: 'Scale' }) },
    };
    const service = new ProductsService(
      prisma as never,
      { updateDefaultBatch } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const stub = service as never as Record<string, unknown>;
    stub.recalculateFinalCustomerPayable = jest.fn();
    stub.revalidateOffer = jest.fn();
    stub.notifyWaitlistedUsers = jest.fn().mockResolvedValue(undefined);
    return { service, prisma, updateDefaultBatch };
  };

  const ordinary = { preOrderDeliveryDate: null };
  const storedPreOrder = { preOrderDeliveryDate: new Date('2026-12-01T00:00:00.000Z') };

  it('leaves the batch untouched when the edit sets a pre-order date', async () => {
    const { service, updateDefaultBatch } = build(ordinary);

    await service.update('user-1', 'offer-1', {
      stock: 0,
      preOrderDeliveryDate: '2026-12-01',
    } as never);

    expect(updateDefaultBatch).not.toHaveBeenCalled();
  });

  it('writes stock when the edit clears the date — pre-order turned off', async () => {
    // The case the naive guard gets wrong: `null` is falsy, so a truthiness
    // check would skip the write and strand the listing at its old stock.
    const { service, updateDefaultBatch } = build(storedPreOrder);

    await service.update('user-1', 'offer-1', {
      stock: 7,
      preOrderDeliveryDate: null,
    } as never);

    expect(updateDefaultBatch).toHaveBeenCalledWith('offer-1', 7);
  });

  it('falls back to the stored date when the edit omits the field', async () => {
    // A partial edit (price only, say) must not quietly convert a pre-order
    // back to tracked stock.
    const { service, updateDefaultBatch } = build(storedPreOrder);

    await service.update('user-1', 'offer-1', { stock: 0, mrp: 1599 } as never);

    expect(updateDefaultBatch).not.toHaveBeenCalled();
  });

  it('still writes stock for an ordinary listing, exactly as before', async () => {
    const { service, updateDefaultBatch } = build(ordinary);

    await service.update('user-1', 'offer-1', { stock: 12 } as never);

    expect(updateDefaultBatch).toHaveBeenCalledWith('offer-1', 12);
  });

  it('persists the date through the rest-spread, without a stock write', async () => {
    // update() never names the field: it rides along in `...productData`.
    const { service, prisma } = build(ordinary);

    await service.update('user-1', 'offer-1', {
      stock: 0,
      preOrderDeliveryDate: '2026-12-01',
    } as never);

    expect(prisma.sellerOffer.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ preOrderDeliveryDate: '2026-12-01' }),
      }),
    );
  });

  /**
   * create() has a name-collision branch: a listing the seller already owns
   * under the same name is UPDATED rather than created, and that path writes
   * the DEFAULT batch of an existing row. It shipped dropping the date and
   * wiping stock, so it is the fourth place a mistake here costs real
   * inventory. Semantics follow the import path, not update()'s tri-state:
   * create() sends a full payload, so no date genuinely means no pre-order.
   */
  describe('the name-reuse branch of create()', () => {
    const payload = (extra: Record<string, unknown>) => ({
      name: 'Levi Ackerman 1/7',
      manufacturer: 'Good Smile',
      categoryId: 'cat-1',
      subCategoryId: 'sub-1',
      mrp: 1599,
      gstPercent: 18,
      ...extra,
    });

    it('keeps the date and leaves the existing batch alone', async () => {
      const { service, prisma, updateDefaultBatch } = build(ordinary);

      await service.create(
        'user-1',
        payload({ stock: 0, preOrderDeliveryDate: '2026-12-01' }) as never,
      );

      expect(updateDefaultBatch).not.toHaveBeenCalled();
      expect(prisma.sellerOffer.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            preOrderDeliveryDate: new Date('2026-12-01'),
          }),
        }),
      );
    });

    it('still writes stock when the payload carries no date', async () => {
      const { service, prisma, updateDefaultBatch } = build(ordinary);

      await service.create('user-1', payload({ stock: 25 }) as never);

      expect(updateDefaultBatch).toHaveBeenCalledWith('offer-1', 25);
      expect(prisma.sellerOffer.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ preOrderDeliveryDate: null }),
        }),
      );
    });
  });

  /**
   * The variants flow has the same two-branch shape, and the same hazard: a
   * variant offer the seller already owns is updated in place. Its stock
   * figure is the per-variant `v.available`, falling back to the form's
   * `normalized.stock` — and the web plan disables the per-variant column for
   * a pre-order, so `available` arrives empty and the fallback hands it the
   * same 0. Guarded on the DTO alone, like the rest of create().
   */
  describe('the variant-reuse branch of create()', () => {
    const payload = (extra: Record<string, unknown>, variant: Record<string, unknown>) => ({
      name: 'Levi Ackerman 1/7',
      manufacturer: 'Good Smile',
      categoryId: 'cat-1',
      subCategoryId: 'sub-1',
      mrp: 1599,
      gstPercent: 18,
      ...extra,
      variants: [{ name: 'Deluxe', price: 0, ...variant }],
    });

    it('keeps the date and leaves the existing variant batch alone', async () => {
      const { service, prisma, updateDefaultBatch } = build(ordinary);

      await service.create(
        'user-1',
        payload({ stock: 0, preOrderDeliveryDate: '2026-12-01' }, { available: 0 }) as never,
      );

      expect(updateDefaultBatch).not.toHaveBeenCalled();
      expect(prisma.sellerOffer.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            preOrderDeliveryDate: new Date('2026-12-01'),
          }),
        }),
      );
    });

    it('still writes the per-variant figure when there is no date', async () => {
      const { service, prisma, updateDefaultBatch } = build(ordinary);

      await service.create('user-1', payload({ stock: 25 }, { available: 9 }) as never);

      // The per-variant figure wins over the form's stock, exactly as before.
      expect(updateDefaultBatch).toHaveBeenCalledWith('offer-1', 9);
      expect(prisma.sellerOffer.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ preOrderDeliveryDate: null }),
        }),
      );
    });
  });
});
