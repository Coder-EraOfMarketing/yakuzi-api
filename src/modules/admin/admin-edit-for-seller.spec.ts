import { NotFoundException } from '@nestjs/common';
import { AdminService } from './admin.service';

/**
 * Editing a seller's listing on their behalf — the counterpart to creating
 * one, and deliberately the same shape: resolve who owns it, then run the
 * seller's own update path as them, so variants, stock, images, pricing and
 * packaging cannot behave differently depending on who pressed save.
 *
 * The trap this pins: SellerOffer.sellerId is the SellerProfile id, while
 * ProductsService.update is keyed by USER id — it looks the profile up
 * itself. Passing the profile id makes every admin edit fail with "seller
 * profile not found", which reads as a permissions bug on a real seller.
 */
function buildService(offer: unknown) {
  const update = jest.fn().mockResolvedValue({ id: 'offer-1', name: 'Updated' });
  const findFirst = jest.fn().mockResolvedValue(offer);
  const service = Object.create(AdminService.prototype) as AdminService;
  Object.assign(service, {
    prisma: { sellerOffer: { findFirst } },
    productsService: { update },
  });
  return { service, update, findFirst };
}

const OFFER = { seller: { userId: 'user-77' } };

describe('AdminService.adminUpdateProductForSeller', () => {
  it('updates as the owning seller, not as the admin', async () => {
    const { service, update } = buildService(OFFER);

    await service.adminUpdateProductForSeller('offer-1', { name: 'New' } as never);

    expect(update).toHaveBeenCalledWith('user-77', 'offer-1', { name: 'New' });
  });

  it('resolves the owner through the profile, not off sellerId', async () => {
    const { service, findFirst } = buildService(OFFER);

    await service.adminUpdateProductForSeller('offer-1', {} as never);

    // Selecting seller.userId rather than the offer's own sellerId is the
    // whole point; asserting the select keeps it from being "simplified".
    expect(findFirst.mock.calls[0][0].select).toEqual({
      seller: { select: { userId: true } },
    });
  });

  it('ignores a soft-deleted listing', async () => {
    const { service, findFirst } = buildService(OFFER);

    await service.adminUpdateProductForSeller('offer-1', {} as never);

    expect(findFirst.mock.calls[0][0].where).toMatchObject({ deletedAt: null });
  });

  it('404s for a listing that does not exist', async () => {
    const { service } = buildService(null);

    await expect(
      service.adminUpdateProductForSeller('missing', {} as never),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('404s rather than calling update with an undefined user', async () => {
    // An offer whose seller row is gone would otherwise reach
    // ProductsService.update as `undefined`, which scopes to nobody.
    const { service, update } = buildService({ seller: null });

    await expect(
      service.adminUpdateProductForSeller('offer-1', {} as never),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(update).not.toHaveBeenCalled();
  });
});
