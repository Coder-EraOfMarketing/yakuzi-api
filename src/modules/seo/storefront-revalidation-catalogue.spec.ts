import { StorefrontRevalidationService } from './storefront-revalidation.service';

/**
 * Every buyer page is `export const revalidate = 300`, so a seller's price
 * change, a new offer, an approval or a master product leaving Draft stayed
 * invisible for up to five minutes. That cache is on the CDN, not in the
 * browser, so the person who made the edit could not clear it by refreshing —
 * the usual next step was to report the save as broken.
 *
 * These cover the two things that matter: the ping names every page the change
 * can affect, and nothing here can turn a successful write into a failed one.
 */
describe('StorefrontRevalidationService catalogue pings', () => {
  const prisma = {
    catalogProduct: { findUnique: jest.fn() },
    sellerOffer: { findUnique: jest.fn() },
  };
  let fetchMock: jest.SpyInstance;
  let service: StorefrontRevalidationService;

  const env = { ...process.env };

  const product = {
    slug: 'naruto-sage-mode',
    category: { slug: 'figurines' },
    subCategory: { slug: 'action-figures' },
    extraCategories: [],
  };

  beforeEach(() => {
    jest.resetAllMocks();
    process.env.STOREFRONT_URL = 'https://storefront.test';
    process.env.STOREFRONT_REVALIDATE_SECRET = 's3cret';
    prisma.catalogProduct.findUnique.mockResolvedValue(product);
    fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue({ ok: true, status: 200 } as Response);
    service = new StorefrontRevalidationService(prisma as never);
  });

  afterEach(() => {
    process.env = { ...env };
  });

  const pathsSent = () =>
    JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string).paths as string[];

  it('names the product page and every shelf it sits on', async () => {
    await service.catalogProductChanged('p1');

    expect(pathsSent()).toEqual([
      '/',
      '/products',
      '/products/naruto-sage-mode',
      '/category/figurines',
      '/category/figurines/action-figures',
    ]);
  });

  it('includes the extra categories a product was also filed under', async () => {
    prisma.catalogProduct.findUnique.mockResolvedValue({
      ...product,
      extraCategories: [{ slug: 'collectables' }, { slug: 'figurines' }],
    });

    await service.catalogProductChanged('p1');

    expect(pathsSent()).toContain('/category/collectables');
    // 'figurines' is already the primary shelf — named once, not twice.
    expect(pathsSent().filter((p) => p === '/category/figurines')).toHaveLength(1);
  });

  it('resolves an offer attached straight to the product', async () => {
    prisma.sellerOffer.findUnique.mockResolvedValue({
      catalogProductId: 'p1',
      variant: null,
    });

    await service.offerChanged('offer-1');

    expect(prisma.catalogProduct.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'p1' } }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('resolves an offer that only reaches its product through a variant', async () => {
    // Which of the two links is set depends on whether the product had variants
    // when the offer was made. Reading only one would skip revalidation for
    // half the catalogue.
    prisma.sellerOffer.findUnique.mockResolvedValue({
      catalogProductId: null,
      variant: { catalogProductId: 'p9' },
    });

    await service.offerChanged('offer-1');

    expect(prisma.catalogProduct.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'p9' } }),
    );
  });

  it('does nothing at all when no secret is configured', async () => {
    delete process.env.STOREFRONT_REVALIDATE_SECRET;

    await service.offerChanged('offer-1');
    await service.catalogProductChanged('p1');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(prisma.sellerOffer.findUnique).not.toHaveBeenCalled();
    expect(prisma.catalogProduct.findUnique).not.toHaveBeenCalled();
  });

  it('stays quiet for an offer that resolves to no product', async () => {
    prisma.sellerOffer.findUnique.mockResolvedValue({
      catalogProductId: null,
      variant: null,
    });

    await service.offerChanged('offer-1');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never lets a storefront problem reach the caller', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(service.catalogProductChanged('p1')).resolves.toBeUndefined();

    fetchMock.mockResolvedValue({ ok: false, status: 401 } as Response);
    await expect(service.catalogProductChanged('p1')).resolves.toBeUndefined();
  });

  it('never lets a database problem reach the caller', async () => {
    prisma.sellerOffer.findUnique.mockRejectedValue(new Error('db down'));
    await expect(service.offerChanged('offer-1')).resolves.toBeUndefined();

    prisma.catalogProduct.findUnique.mockRejectedValue(new Error('db down'));
    await expect(service.catalogProductChanged('p1')).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
