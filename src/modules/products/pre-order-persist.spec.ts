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
describe('ProductsService update() stock guard for pre-orders', () => {
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
      catalogProduct: { findFirst: jest.fn().mockResolvedValue(null) },
      productBatch: { findFirst: jest.fn().mockResolvedValue(null) },
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
});
