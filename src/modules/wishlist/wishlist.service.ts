import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

/**
 * A buyer's saved items, on the server rather than in one browser.
 *
 * The storefront kept this in localStorage alone, so it did not follow anyone
 * to a second device and did not survive clearing the browser.
 *
 * What is stored is the id the storefront saves — a SellerOffer id today —
 * held as a plain string, not a foreign key. A delisted listing must not
 * cascade somebody's saved list away with it. Resolution to a product happens
 * on read, and an id that no longer resolves is dropped from the response
 * rather than returned as an empty card.
 */

export interface WishlistProduct {
  id: string;
  name: string;
  slug?: string | null;
  price: number;
  mrp?: number | null;
  images: string[];
  manufacturer?: string | null;
  stock?: number | null;
}

export interface WishlistEntry {
  id: string;
  productId: string;
  createdAt: string;
  product?: WishlistProduct;
}

@Injectable()
export class WishlistService {
  private readonly logger = new Logger(WishlistService.name);

  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string): Promise<{ items: WishlistEntry[]; total: number }> {
    const rows = await this.prisma.wishlistItem.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    if (rows.length === 0) return { items: [], total: 0 };

    const products = await this.resolveProducts(rows.map((r) => r.productId));

    const items = rows
      .map((row) => ({
        id: row.id,
        productId: row.productId,
        createdAt: row.createdAt.toISOString(),
        product: products.get(row.productId),
      }))
      // An id that resolves to nothing is a listing that has gone. Returning it
      // would render a blank card the buyer cannot act on.
      .filter((item) => !!item.product);

    return { items, total: items.length };
  }

  /**
   * Saving the same item twice is a no-op rather than an error: the storefront
   * fires this optimistically and a duplicate tap must not surface a failure.
   */
  async add(userId: string, productId: string): Promise<WishlistEntry> {
    const row = await this.prisma.wishlistItem.upsert({
      where: { userId_productId: { userId, productId } },
      update: {},
      create: { userId, productId },
    });

    return {
      id: row.id,
      productId: row.productId,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /**
   * By productId, not by row id — that is what the storefront holds when a
   * buyer un-bookmarks something. Removing what is not there succeeds.
   */
  async remove(userId: string, productId: string): Promise<{ removed: number }> {
    const { count } = await this.prisma.wishlistItem.deleteMany({
      where: { userId, productId },
    });
    return { removed: count };
  }

  /**
   * Merges a browser's list into the account's, for the moment someone signs
   * in with items already saved locally. Additive: it never removes, because a
   * device that has been offline must not delete what was saved elsewhere.
   */
  async merge(userId: string, productIds: string[]): Promise<{ added: number }> {
    const unique = Array.from(
      new Set(productIds.filter((id) => typeof id === 'string' && id.trim())),
    ).slice(0, 200);
    if (unique.length === 0) return { added: 0 };

    const { count } = await this.prisma.wishlistItem.createMany({
      data: unique.map((productId) => ({ userId, productId })),
      skipDuplicates: true,
    });
    return { added: count };
  }

  /**
   * Saved ids to displayable products.
   *
   * A saved id is a SellerOffer, but older entries may hold a CatalogProduct
   * id, so both are looked up and whichever answers wins. Two queries, not one
   * per item.
   */
  private async resolveProducts(
    ids: string[],
  ): Promise<Map<string, WishlistProduct>> {
    const found = new Map<string, WishlistProduct>();
    const unique = Array.from(new Set(ids));
    if (unique.length === 0) return found;

    try {
      const offers = await this.prisma.sellerOffer.findMany({
        where: { id: { in: unique } },
        select: {
          id: true,
          name: true,
          manufacturer: true,
          mrp: true,
          finalCustomerPayable: true,
          variant: {
            select: {
              catalogProduct: {
                select: {
                  slug: true,
                  images: {
                    select: { url: true },
                    orderBy: [{ order: 'asc' }, { id: 'asc' }],
                  },
                },
              },
            },
          },
        },
      });

      for (const offer of offers) {
        const catalog = offer.variant?.catalogProduct;
        found.set(offer.id, {
          id: offer.id,
          name: offer.name,
          slug: catalog?.slug ?? null,
          // What a buyer would actually pay, falling back to the listed price.
          price: Number(offer.finalCustomerPayable ?? offer.mrp ?? 0),
          mrp: offer.mrp != null ? Number(offer.mrp) : null,
          images: (catalog?.images ?? []).map((i) => i.url),
          manufacturer: offer.manufacturer,
        });
      }

      const unresolved = unique.filter((id) => !found.has(id));
      if (unresolved.length > 0) {
        const catalogProducts = await this.prisma.catalogProduct.findMany({
          where: { id: { in: unresolved }, deletedAt: null },
          select: {
            id: true,
            name: true,
            slug: true,
            images: {
              select: { url: true },
              orderBy: [{ order: 'asc' }, { id: 'asc' }],
            },
          },
        });
        for (const product of catalogProducts) {
          found.set(product.id, {
            id: product.id,
            name: product.name,
            slug: product.slug,
            price: 0,
            mrp: null,
            images: product.images.map((i) => i.url),
          });
        }
      }
    } catch (error) {
      // A resolution failure must not empty somebody's wishlist screen with an
      // error; the ids are still returned and the storefront renders what it
      // has cached.
      this.logger.warn(
        `Could not resolve wishlist products: ${(error as Error)?.message}`,
      );
    }

    return found;
  }
}
