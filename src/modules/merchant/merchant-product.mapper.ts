/**
 * Maps a Yukizi catalogue product to a Google Merchant API product input.
 *
 * Pure and isolated on purpose: this is the part with real correctness risk
 * (Google rejects a product for a surprising number of reasons), and the only
 * part testable without live Google credentials.
 *
 * Google's hard requirements for a free/Shopping listing: a title, a
 * description, a working product URL, an image URL, a price, and an
 * availability. A product missing any of those is not rejected item-by-item at
 * the sync — it is dropped here, with a reason the caller can log, so one bad
 * row never fails a whole run.
 */

export interface CatalogProductForFeed {
  id: string;
  slug: string | null;
  name: string;
  description: string | null;
  manufacturer: string | null;
  category: string | null;
  imageUrl: string | null;
  /** Cheapest live approved offer price, or null when nothing is sellable. */
  price: number | null;
  stock: number;
}

export interface MerchantProductInput {
  offerId: string;
  contentLanguage: string;
  feedLabel: string;
  /** Renamed from `attributes` in Merchant API v1. */
  productAttributes: Record<string, unknown>;
}

export type MapResult =
  | { ok: true; product: MerchantProductInput }
  | { ok: false; offerId: string; reason: string };

const MAX_TITLE = 150;
const MAX_DESCRIPTION = 5000;

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    // A stripped tag before punctuation ("Three</b>." ) leaves " Three ." —
    // pull the punctuation back onto the word.
    .replace(/\s+([.,;:!?)])/g, '$1')
    .trim();
}

function clamp(text: string, max: number): string {
  const clean = text.trim();
  return clean.length <= max ? clean : clean.slice(0, max - 1).trimEnd() + '…';
}

export function mapToMerchantProduct(
  p: CatalogProductForFeed,
  opts: {
    siteUrl: string;
    contentLanguage?: string;
    feedLabel?: string;
    currency?: string;
    /**
     * ISO date a few weeks out. Set on every push so a product that stops
     * being synced (deleted from the catalogue, sold out of every offer)
     * auto-expires from Merchant Center instead of lingering as a live
     * listing — no separate "delete removed products" bookkeeping needed.
     */
    expirationDate?: string;
  },
): MapResult {
  const offerId = (p.slug || p.id).trim();

  // A product URL must be real: the storefront route is /products/<slug>, and a
  // guessed link is a disapproval (and a broken click).
  if (!p.slug) {
    return { ok: false, offerId, reason: 'no slug — cannot build a product URL' };
  }
  if (p.price == null) {
    return { ok: false, offerId, reason: 'no live approved offer — no price to advertise' };
  }
  if (!p.imageUrl) {
    return { ok: false, offerId, reason: 'no image — Google requires an image link' };
  }

  const title = clamp(p.name || '', MAX_TITLE);
  if (!title) {
    return { ok: false, offerId, reason: 'no title' };
  }

  const descriptionSource = (p.description && stripHtml(p.description)) || p.name || '';
  const siteUrl = opts.siteUrl.replace(/\/$/, '');

  const attributes: Record<string, unknown> = {
    title,
    description: clamp(descriptionSource, MAX_DESCRIPTION),
    link: `${siteUrl}/products/${p.slug}`,
    imageLink: p.imageUrl,
    // Enums in v1, not the free strings v1beta accepted ('in_stock', 'new').
    availability: p.stock > 0 ? 'IN_STOCK' : 'OUT_OF_STOCK',
    condition: 'NEW',
    price: {
      // Merchant API takes price as integer micros in a string.
      amountMicros: String(Math.round(p.price * 1_000_000)),
      currencyCode: opts.currency ?? 'INR',
    },
  };

  const brand = p.manufacturer?.trim();
  if (brand && brand.toLowerCase() !== 'unknown') {
    attributes.brand = brand;
  }
  // Collectibles rarely carry a GTIN/MPN. Declaring none is required, or Google
  // waits for an identifier that will never come and leaves the item pending.
  attributes.identifierExists = false;

  if (p.category?.trim()) {
    attributes.productTypes = [p.category.trim()];
  }

  if (opts.expirationDate) {
    attributes.expirationDate = opts.expirationDate;
  }

  return {
    ok: true,
    product: {
      offerId,
      contentLanguage: opts.contentLanguage ?? 'en',
      feedLabel: opts.feedLabel ?? 'IN',
      productAttributes: attributes,
    },
  };
}
