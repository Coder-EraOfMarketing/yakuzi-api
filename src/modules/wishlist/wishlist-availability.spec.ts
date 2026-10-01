import { ProductApprovalStatus } from '@prisma/client';
import { WishlistService } from './wishlist.service';

/**
 * "Draft" only ever meant "hidden from browse". Every by-id path ignored
 * CatalogProduct.isActive, so two Draft products sat in a buyer's saved list
 * with a working Add button — and the bag accepted them.
 *
 * A save must still resolve to a card once what it points at stops being for
 * sale, or an admin's edit would silently delete items out of someone's saved
 * list. It comes back marked unavailable instead, and the storefront greys it
 * out.
 */
describe('WishlistService availability', () => {
  const prisma = {
    wishlistItem: { findMany: jest.fn() },
    sellerOffer: { findMany: jest.fn() },
    catalogProduct: { findMany: jest.fn() },
  };
  const service = new WishlistService(prisma as never);

  const images = [{ url: 'http://img/1.png' }];

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.wishlistItem.findMany.mockResolvedValue([
      { id: 'w1', productId: 'x1', createdAt: new Date() },
    ]);
    prisma.sellerOffer.findMany.mockResolvedValue([]);
    prisma.catalogProduct.findMany.mockResolvedValue([]);
  });

  const master = (over: Record<string, unknown> = {}) => ({
    id: 'p1',
    slug: 'a-product',
    isActive: true,
    deletedAt: null,
    images,
    ...over,
  });

  const offerRow = (over: Record<string, unknown> = {}) => ({
    id: 'x1',
    name: 'Testing',
    manufacturer: 'Yukizi',
    mrp: 11,
    finalCustomerPayable: 11,
    catalogProductId: 'p1',
    isActive: true,
    approvalStatus: ProductApprovalStatus.APPROVED,
    deletedAt: null,
    catalogProduct: master(),
    variant: null,
    ...over,
  });

  const firstProduct = async () => {
    const res = await service.list('user-1');
    return res.items[0]?.product;
  };

  describe('a save that points at a listing', () => {
    it('is available when both the listing and its product are live', async () => {
      prisma.sellerOffer.findMany.mockResolvedValue([offerRow()]);

      expect((await firstProduct())?.available).toBe(true);
    });

    it('is unavailable when the product behind it went back to Draft', async () => {
      // The listing itself is untouched and still approved — this is exactly
      // the reported case.
      prisma.sellerOffer.findMany.mockResolvedValue([
        offerRow({ catalogProduct: master({ isActive: false }) }),
      ]);

      const product = await firstProduct();
      expect(product).toBeDefined();
      expect(product?.available).toBe(false);
    });

    it('is unavailable when the listing was delisted or unapproved', async () => {
      prisma.sellerOffer.findMany.mockResolvedValue([offerRow({ isActive: false })]);
      expect((await firstProduct())?.available).toBe(false);

      prisma.sellerOffer.findMany.mockResolvedValue([
        offerRow({ approvalStatus: ProductApprovalStatus.PENDING }),
      ]);
      expect((await firstProduct())?.available).toBe(false);
    });

    it('reads the master through the variant when that is the only link', async () => {
      prisma.sellerOffer.findMany.mockResolvedValue([
        offerRow({
          catalogProduct: null,
          variant: { catalogProduct: master({ isActive: false }) },
        }),
      ]);

      expect((await firstProduct())?.available).toBe(false);
    });
  });

  describe('a save that points at a catalog product', () => {
    it('is unavailable while the product is in Draft', async () => {
      prisma.catalogProduct.findMany.mockResolvedValue([
        { id: 'x1', name: 'Testing', slug: 's', manufacturer: 'Y', mrp: 11, isActive: false, images },
      ]);
      prisma.sellerOffer.findMany.mockResolvedValue([]); // cheapestOfferPrices

      const product = await firstProduct();
      expect(product).toBeDefined();
      expect(product?.available).toBe(false);
    });

    it('is unavailable when the product is Active but nobody is selling it', async () => {
      prisma.catalogProduct.findMany.mockResolvedValue([
        { id: 'x1', name: 'Testing', slug: 's', manufacturer: 'Y', mrp: 11, isActive: true, images },
      ]);
      prisma.sellerOffer.findMany.mockResolvedValue([]);

      expect((await firstProduct())?.available).toBe(false);
    });
  });

  it('keeps the card in the list either way, rather than dropping it', async () => {
    prisma.sellerOffer.findMany.mockResolvedValue([
      offerRow({ catalogProduct: master({ isActive: false }) }),
    ]);

    const res = await service.list('user-1');

    expect(res.items).toHaveLength(1);
    expect(res.total).toBe(1);
    expect(res.items[0].product?.name).toBe('Testing');
  });
});
