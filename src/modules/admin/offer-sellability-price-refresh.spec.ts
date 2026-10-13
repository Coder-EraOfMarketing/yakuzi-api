import { AdminService } from './admin.service';
import { ProductApprovalStatus } from '@prisma/client';

/**
 * CatalogProduct.lowestOfferPrice is the cheapest live offer, and it is what
 * the browse grid now sorts on. recalculateFinalCustomerPayable is the hook for
 * every path that changes an offer's PRICE — but these five admin paths change
 * whether an offer is SELLABLE at all without touching a price, so none of them
 * reaches it. Each one adds or removes a candidate from the master's minimum,
 * so each one has to refresh it; a stale value here is a wrong price on the
 * shelf, and on the disable/reject/delete side it is a price nobody can buy at.
 */
const build = (offer: Record<string, unknown>) => {
  const prisma = {
    sellerOffer: {
      findUnique: jest.fn().mockResolvedValue(offer),
      update: jest.fn().mockResolvedValue({ id: 'offer-1' }),
    },
  };
  const productsService = {
    recalculateLowestOfferPriceForOffer: jest.fn().mockResolvedValue(undefined),
  };
  const service = new AdminService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    productsService as never,
    { get: jest.fn() } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, productsService };
};

const live = {
  id: 'offer-1',
  isActive: true,
  deletedAt: null,
  variantId: 'variant-1',
  approvalStatus: ProductApprovalStatus.PENDING,
  name: 'Thing',
  manufacturer: 'Maker',
};

describe('admin offer-state changes refresh the master lowest price', () => {
  it('disableProduct refreshes it — the offer just left the minimum', async () => {
    const { service, productsService } = build({ ...live });

    await service.disableProduct('offer-1');

    expect(
      productsService.recalculateLowestOfferPriceForOffer,
    ).toHaveBeenCalledWith('offer-1');
  });

  it('enableProduct refreshes it — the offer just joined the minimum', async () => {
    const { service, productsService } = build({ ...live, isActive: false });

    await service.enableProduct('offer-1');

    expect(
      productsService.recalculateLowestOfferPriceForOffer,
    ).toHaveBeenCalledWith('offer-1');
  });

  it('softDeleteProduct refreshes it', async () => {
    const { service, productsService } = build({ ...live });

    await service.softDeleteProduct('offer-1');

    expect(
      productsService.recalculateLowestOfferPriceForOffer,
    ).toHaveBeenCalledWith('offer-1');
  });

  it('approveProduct refreshes it — approval is when the offer becomes buyable', async () => {
    // variantId already set, so the master-resolution branch is skipped and
    // this spec stays on the refresh.
    const { service, productsService } = build({ ...live });

    await service.approveProduct('offer-1');

    expect(
      productsService.recalculateLowestOfferPriceForOffer,
    ).toHaveBeenCalledWith('offer-1');
  });

  it('rejectProduct refreshes it — rejection deactivates the offer', async () => {
    const { service, productsService } = build({ ...live });

    await service.rejectProduct('offer-1', 'bad photos');

    expect(
      productsService.recalculateLowestOfferPriceForOffer,
    ).toHaveBeenCalledWith('offer-1');
  });
});
