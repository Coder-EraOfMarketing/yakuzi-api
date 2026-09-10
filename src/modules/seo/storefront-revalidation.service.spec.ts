import { SeoEntityType } from '@prisma/client';
import { StorefrontRevalidationService } from './storefront-revalidation.service';

/**
 * The storefront caches an SEO override for five minutes and the page that
 * reads it for another five, so an admin's save used to take up to ten
 * minutes to show — long enough that people re-saved, assuming it had failed.
 *
 * These cover the two things that matter: the ping carries enough for the
 * storefront to drop the right entries, and a storefront that is down, slow
 * or misconfigured can never turn an admin's successful save into an error.
 */
describe('StorefrontRevalidationService', () => {
  const prisma = {
    catalogProduct: { findUnique: jest.fn() },
  };
  let fetchMock: jest.SpyInstance;
  let service: StorefrontRevalidationService;

  const env = { ...process.env };

  beforeEach(() => {
    jest.resetAllMocks();
    process.env.STOREFRONT_URL = 'https://storefront.test';
    process.env.STOREFRONT_REVALIDATE_SECRET = 's3cret';
    prisma.catalogProduct.findUnique.mockResolvedValue({ slug: 'iron-man-helmet' });
    fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue({ ok: true, status: 200 } as Response);
    service = new StorefrontRevalidationService(prisma as never);
  });

  afterEach(() => {
    process.env = { ...env };
  });

  function bodyOf(call: unknown[]): { tags?: string[]; paths?: string[] } {
    return JSON.parse((call[1] as RequestInit).body as string);
  }

  it('does nothing when no secret is configured', async () => {
    delete process.env.STOREFRONT_REVALIDATE_SECRET;

    await service.seoMetaChanged(SeoEntityType.PRODUCT, 'abc');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(prisma.catalogProduct.findUnique).not.toHaveBeenCalled();
  });

  it('pings the storefront with the entity tag and the secret header', async () => {
    await service.seoMetaChanged(SeoEntityType.PRODUCT, 'abc');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://storefront.test/api/revalidate');
    expect((init as RequestInit).method).toBe('POST');
    expect((init as Record<string, any>).headers['x-revalidate-secret']).toBe('s3cret');
    expect(bodyOf(fetchMock.mock.calls[0]).tags).toEqual(['seo:PRODUCT:abc']);
  });

  it('also names the product page, so the render is dropped and not just the data', async () => {
    await service.seoMetaChanged(SeoEntityType.PRODUCT, 'abc');

    expect(bodyOf(fetchMock.mock.calls[0]).paths).toEqual(['/products/iron-man-helmet']);
  });

  it('sends the tag alone when the product has no slug of its own', async () => {
    prisma.catalogProduct.findUnique.mockResolvedValue({ slug: null });

    await service.seoMetaChanged(SeoEntityType.PRODUCT, 'abc');

    expect(bodyOf(fetchMock.mock.calls[0]).paths).toEqual([]);
  });

  it('looks up no product for entity types that are not products', async () => {
    await service.seoMetaChanged(SeoEntityType.CATEGORY, 'cat-1');

    expect(prisma.catalogProduct.findUnique).not.toHaveBeenCalled();
    expect(bodyOf(fetchMock.mock.calls[0]).tags).toEqual(['seo:CATEGORY:cat-1']);
  });

  it('swallows a storefront that refuses the connection', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(service.seoMetaChanged(SeoEntityType.PRODUCT, 'abc')).resolves.toBeUndefined();
  });

  it('swallows a storefront that answers with an error status', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401 } as Response);

    await expect(service.seoMetaChanged(SeoEntityType.PRODUCT, 'abc')).resolves.toBeUndefined();
  });

  it('still pings when the slug lookup fails — the tag alone does the job', async () => {
    prisma.catalogProduct.findUnique.mockRejectedValue(new Error('db down'));

    await expect(service.seoMetaChanged(SeoEntityType.PRODUCT, 'abc')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bodyOf(fetchMock.mock.calls[0]).paths).toEqual([]);
  });
});
