import { Injectable, Logger } from '@nestjs/common';
import { SeoEntityType } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

const FETCH_TIMEOUT_MS = 3000;

/**
 * Tells the storefront to drop what it has cached for one entity.
 *
 * Without this, an admin's SEO edit waits out two independent five-minute
 * caches in the buyer app — the `/seo/meta` fetch and the page render that
 * used it — so a new FAQ could take up to ten minutes to appear. Long enough
 * that the save looks broken.
 *
 * The same five minutes applies to the catalogue itself: every buyer page is
 * `export const revalidate = 300`, so a seller's price change, a new offer, an
 * approval or a master product moving out of Draft all sat invisible for up to
 * five minutes. That cache lives on the CDN, not in the browser, so no amount
 * of refreshing by the person who made the edit can shift it — the usual next
 * step is to report the save as broken. offerChanged/catalogProductChanged
 * name the affected pages the moment the write lands.
 *
 * Entirely optional and entirely silent. With STOREFRONT_REVALIDATE_SECRET
 * unset the ping is skipped and the storefront simply refreshes on its timer
 * as before; if the storefront is down, slow or rejects the secret, the admin
 * still gets a successful save. Cache freshness must never be able to fail a
 * write.
 */
@Injectable()
export class StorefrontRevalidationService {
  private readonly logger = new Logger(StorefrontRevalidationService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Call after a SeoMeta row is written. Never throws, never rejects — callers
   * are expected to `void` it rather than await it.
   */
  async seoMetaChanged(entityType: SeoEntityType, entityId: string): Promise<void> {
    const secret = process.env.STOREFRONT_REVALIDATE_SECRET;
    if (!secret) return;

    // The tag is what the storefront's fetch is labelled with, so dropping it
    // invalidates both the cached response and every render that used it.
    // The path is belt-and-braces for the one page we can name with certainty.
    const tags = [`seo:${entityType}:${entityId}`];
    const paths = await this.pathsFor(entityType, entityId);

    await this.ping(tags, paths, secret, tags[0]);
  }

  /**
   * Call after any write to a SellerOffer — create, edit, approve, reject,
   * enable, disable, delete.
   *
   * An offer reaches its product two ways, `catalogProductId` directly or
   * `variantId` through a ProductVariant, and which one is set depends on
   * whether the product had variants when the offer was made. Reading only one
   * of them would silently skip revalidation for half the catalogue, so both
   * are resolved here (the same dual path collectListings() has to handle).
   */
  async offerChanged(sellerOfferId: string): Promise<void> {
    const secret = process.env.STOREFRONT_REVALIDATE_SECRET;
    if (!secret) return;

    let catalogProductId: string | null = null;
    try {
      const offer = await this.prisma.sellerOffer.findUnique({
        where: { id: sellerOfferId },
        select: {
          catalogProductId: true,
          variant: { select: { catalogProductId: true } },
        },
      });
      catalogProductId = offer?.catalogProductId ?? offer?.variant?.catalogProductId ?? null;
    } catch (err) {
      this.logger.warn(
        `Could not resolve the product behind offer ${sellerOfferId}: ${(err as Error)?.message ?? err}`,
      );
      return;
    }

    if (!catalogProductId) return;
    await this.catalogProductChanged(catalogProductId);
  }

  /**
   * Call after any write to a CatalogProduct — including the Draft/Active flip,
   * which decides whether the product is on the storefront at all.
   */
  async catalogProductChanged(catalogProductId: string): Promise<void> {
    const secret = process.env.STOREFRONT_REVALIDATE_SECRET;
    if (!secret) return;

    const paths = await this.storefrontPathsFor(catalogProductId);
    if (paths.length === 0) return;

    // No tags: only the SEO override fetch is labelled with one, so for a
    // catalogue change the paths are what actually does the work.
    await this.ping([], paths, secret, `product:${catalogProductId}`);
  }

  /**
   * Every page whose content can change when this product does: its own page,
   * the all-products list, the home page's carousels, and each category and
   * sub-category shelf it sits on.
   */
  private async storefrontPathsFor(catalogProductId: string): Promise<string[]> {
    try {
      const product = await this.prisma.catalogProduct.findUnique({
        where: { id: catalogProductId },
        select: {
          slug: true,
          category: { select: { slug: true } },
          subCategory: { select: { slug: true } },
          extraCategories: { select: { slug: true } },
        },
      });
      if (!product) return [];

      const paths = ['/', '/products'];
      if (product.slug) paths.push(`/products/${product.slug}`);

      const categorySlug = product.category?.slug;
      if (categorySlug) {
        paths.push(`/category/${categorySlug}`);
        if (product.subCategory?.slug) {
          paths.push(`/category/${categorySlug}/${product.subCategory.slug}`);
        }
      }
      for (const extra of product.extraCategories ?? []) {
        if (extra?.slug) paths.push(`/category/${extra.slug}`);
      }

      // The storefront caps what it will accept; de-duplicate so that budget is
      // spent on distinct pages rather than the same shelf twice.
      return [...new Set(paths)];
    } catch (err) {
      this.logger.warn(
        `Could not resolve storefront paths for ${catalogProductId}: ${(err as Error)?.message ?? err}`,
      );
      return [];
    }
  }

  /** Fire the ping. Never throws — a cold cache is not worth a failed write. */
  private async ping(
    tags: string[],
    paths: string[],
    secret: string,
    label: string,
  ): Promise<void> {
    const base = (process.env.STOREFRONT_URL || 'https://yukizi.com').replace(/\/$/, '');
    const url = `${base}/api/revalidate`;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-revalidate-secret': secret,
        },
        body: JSON.stringify({ tags, paths }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        this.logger.warn(`Storefront revalidation refused (${res.status}) for ${label}`);
      }
    } catch (err) {
      this.logger.warn(
        `Storefront revalidation failed for ${label}: ${(err as Error)?.message ?? err}`,
      );
    }
  }

  /**
   * Public paths this entity is known to own. Only products for now: a
   * category's URL is not derivable here without more lookups, and its tag
   * already covers it.
   */
  private async pathsFor(entityType: SeoEntityType, entityId: string): Promise<string[]> {
    if (entityType !== SeoEntityType.PRODUCT) return [];
    try {
      const product = await this.prisma.catalogProduct.findUnique({
        where: { id: entityId },
        select: { slug: true },
      });
      return product?.slug ? [`/products/${product.slug}`] : [];
    } catch (err) {
      this.logger.warn(`Could not resolve product slug for ${entityId}: ${(err as Error)?.message}`);
      return [];
    }
  }
}
