import { mapToMerchantProduct, CatalogProductForFeed } from './merchant-product.mapper';

const base: CatalogProductForFeed = {
  id: 'prod-1',
  slug: 'akaza-yukizi',
  name: 'Akaza Collectible Statue – Demon Slayer',
  description: '<p>Upper Moon <b>Three</b>.</p>',
  manufacturer: 'Banpresto',
  category: 'Figurines',
  imageUrl: 'https://cdn/img.jpg',
  price: 1044.16,
  stock: 3,
};

const opts = { siteUrl: 'https://yukizi.com' };

describe('mapToMerchantProduct', () => {
  it('maps a complete product to a Merchant API input', () => {
    const r = mapToMerchantProduct(base, opts);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.product.offerId).toBe('akaza-yukizi');
    // `channel` was removed in Merchant API v1 — sending it is rejected.
    expect(r.product).not.toHaveProperty('channel');
    expect(r.product.feedLabel).toBe('IN');
    expect(r.product.attributes.link).toBe('https://yukizi.com/products/akaza-yukizi');
    expect(r.product.attributes.imageLink).toBe('https://cdn/img.jpg');
    expect(r.product.attributes.brand).toBe('Banpresto');
    expect(r.product.attributes.identifierExists).toBe(false);
    expect(r.product.attributes.availability).toBe('in_stock');
    expect(r.product.attributes.price).toEqual({ amountMicros: '1044160000', currencyCode: 'INR' });
    // HTML is stripped from the description.
    expect(r.product.attributes.description).toBe('Upper Moon Three.');
  });

  it('marks a zero-stock product out_of_stock, still listed', () => {
    const r = mapToMerchantProduct({ ...base, stock: 0 }, opts);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.product.attributes.availability).toBe('out_of_stock');
  });

  it('drops a product with no live price', () => {
    const r = mapToMerchantProduct({ ...base, price: null }, opts);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no live approved offer/);
  });

  it('drops a product with no image (Google would reject it)', () => {
    const r = mapToMerchantProduct({ ...base, imageUrl: null }, opts);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/image/);
  });

  it('drops a product with no slug (no real URL to link to)', () => {
    const r = mapToMerchantProduct({ ...base, slug: null }, opts);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/slug/);
  });

  it('omits an Unknown/blank brand rather than advertising it', () => {
    expect((mapToMerchantProduct({ ...base, manufacturer: 'Unknown' }, opts) as any).product.attributes.brand).toBeUndefined();
    expect((mapToMerchantProduct({ ...base, manufacturer: null }, opts) as any).product.attributes.brand).toBeUndefined();
  });

  it('rounds price to whole micros', () => {
    const r = mapToMerchantProduct({ ...base, price: 250 }, opts);
    if (r.ok) expect((r.product.attributes.price as any).amountMicros).toBe('250000000');
  });

  it('truncates an overlong title', () => {
    const r = mapToMerchantProduct({ ...base, name: 'x'.repeat(300) }, opts);
    if (r.ok) expect((r.product.attributes.title as string).length).toBeLessThanOrEqual(150);
  });

  it('trims a trailing slash on the site URL so links are not doubled', () => {
    const r = mapToMerchantProduct(base, { siteUrl: 'https://yukizi.com/' });
    if (r.ok) expect(r.product.attributes.link).toBe('https://yukizi.com/products/akaza-yukizi');
  });
});
