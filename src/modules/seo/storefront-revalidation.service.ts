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
        this.logger.warn(`Storefront revalidation refused (${res.status}) for ${tags[0]}`);
      }
    } catch (err) {
      this.logger.warn(
        `Storefront revalidation failed for ${tags[0]}: ${(err as Error)?.message ?? err}`,
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
