import { mapToMerchantProduct, boundedOfferId, CatalogProductForFeed } from './merchant-product.mapper';

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
    expect(r.product.productAttributes.link).toBe('https://yukizi.com/products/akaza-yukizi');
    expect(r.product.productAttributes.imageLink).toBe('https://cdn/img.jpg');
    expect(r.product.productAttributes.brand).toBe('Banpresto');
    expect(r.product.productAttributes.identifierExists).toBe(false);
    expect(r.product.productAttributes.availability).toBe('IN_STOCK');
    expect(r.product.productAttributes.price).toEqual({ amountMicros: '1044160000', currencyCode: 'INR' });
    // HTML is stripped from the description.
    expect(r.product.productAttributes.description).toBe('Upper Moon Three.');
  });

  it('marks a zero-stock product out_of_stock, still listed', () => {
    const r = mapToMerchantProduct({ ...base, stock: 0 }, opts);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.product.productAttributes.availability).toBe('OUT_OF_STOCK');
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
    expect((mapToMerchantProduct({ ...base, manufacturer: 'Unknown' }, opts) as any).product.productAttributes.brand).toBeUndefined();
    expect((mapToMerchantProduct({ ...base, manufacturer: null }, opts) as any).product.productAttributes.brand).toBeUndefined();
  });

  it('rounds price to whole micros', () => {
    const r = mapToMerchantProduct({ ...base, price: 250 }, opts);
    if (r.ok) expect((r.product.productAttributes.price as any).amountMicros).toBe('250000000');
  });

  it('truncates an overlong title', () => {
    const r = mapToMerchantProduct({ ...base, name: 'x'.repeat(300) }, opts);
    if (r.ok) expect((r.product.productAttributes.title as string).length).toBeLessThanOrEqual(150);
  });

  it('trims a trailing slash on the site URL so links are not doubled', () => {
    const r = mapToMerchantProduct(base, { siteUrl: 'https://yukizi.com/' });
    if (r.ok) expect(r.product.productAttributes.link).toBe('https://yukizi.com/products/akaza-yukizi');
  });
});

/**
 * Google rejected every product with
 * `Validation failed: Value too long in attribute: id` — the `id` attribute
 * caps at 50 characters and Yukizi's slugs run to 76.
 *
 * The offer id is the product's IDENTITY in Merchant Center, so the fix has
 * two properties that matter more than the length itself, and each has a
 * silent failure mode:
 *   - not stable  -> every sync creates a duplicate listing instead of
 *                    updating the existing one
 *   - not unique  -> one product silently overwrites another, because these
 *                    slugs share very long prefixes
 */
describe('boundedOfferId', () => {
  const LONG = 'luffy-and-shanks-straw-hat-moment-collectible-figure-set-or-one-piece-unknown';

  it('leaves a slug that already fits untouched', () => {
    expect(boundedOfferId('akaza-yukizi')).toBe('akaza-yukizi');
  });

  it('keeps a 50-character slug exactly as it is', () => {
    const exact = 'a'.repeat(50);
    expect(boundedOfferId(exact)).toBe(exact);
  });

  it("brings an over-long slug within Google's 50-character limit", () => {
    expect(LONG.length).toBeGreaterThan(50);
    expect(boundedOfferId(LONG).length).toBeLessThanOrEqual(50);
  });

  it('is stable — the same slug always yields the same id', () => {
    // If this ever drifts, every sync creates duplicates on Google rather
    // than updating what is already there.
    expect(boundedOfferId(LONG)).toBe(boundedOfferId(LONG));
  });

  it('distinguishes slugs that share their first 50 characters', () => {
    // The real collision risk: plain truncation would map both of these to
    // the same id and one product would overwrite the other.
    const prefix = 'sanji-ifrit-jambe-collectible-statue-28cm-or-one-piece';
    const a = `${prefix}-red`;
    const b = `${prefix}-blue`;

    expect(a.slice(0, 50)).toBe(b.slice(0, 50)); // truncation alone collides
    expect(boundedOfferId(a)).not.toBe(boundedOfferId(b));
  });

  it('does not leave a trailing hyphen before the digest', () => {
    const s = 'x'.repeat(40) + '-' + 'y'.repeat(40);
    expect(boundedOfferId(s)).not.toMatch(/--/);
  });

  it('is applied by the mapper, not just available', () => {
    const r = mapToMerchantProduct({ ...base, slug: LONG }, opts);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.product.offerId.length).toBeLessThanOrEqual(50);
    expect(r.product.offerId).toBe(boundedOfferId(LONG));
  });
});
