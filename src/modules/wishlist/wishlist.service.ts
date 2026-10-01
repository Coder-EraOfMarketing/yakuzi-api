import { Injectable, Logger } from '@nestjs/common';
import { ProductApprovalStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

/**
 * A buyer's saved items, on the server rather than in one browser.
 *
 * The storefront kept this in localStorage alone, so it did not follow anyone
 * to a second device and did not survive clearing the browser.
 *
 * A save is filed under the CatalogProduct it means — see canonicalIds below
 * — held as a plain string, not a foreign key. A delisted listing must not
 * cascade somebody's saved list away with it. Resolution to something
 * displayable happens on read, and an id that no longer resolves is dropped
 * from the response rather than returned as an empty card.
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
  /**
   * The listing "Add" puts in the bag. A save is filed against a product, but
   * a cart line is a listing, and the storefront has always read this field
   * and fallen back to the saved id when it was missing — which it always
   * was, so the bag received an id that is not a listing and dropped the line
   * on its next check.
   */
  bestListingId?: string | null;
  /**
   * Whether a buyer can actually act on this save right now.
   *
   * A save outlives what it points at. The master product can be put back into
   * Draft, or the only seller can delist, and neither removes the row — so the
   * saved list was offering an "Add" for products that are not for sale, and
   * the bag accepted them. False means the storefront shows the card greyed
   * out with no Add, rather than the item silently vanishing from someone's
   * saved list the moment an admin edits it.
   */
  available: boolean;
}

export interface WishlistEntry {
  id: string;
  productId: string;
  createdAt: string;
  product?: WishlistProduct;
}

/** A resolved save, plus the product it is really about, for de-duplicating. */
interface ResolvedSave {
  catalogId: string;
  product: WishlistProduct;
}

/** The live listing a product currently sells at its lowest price. */
interface CheapestOffer {
  id: string;
  price: number;
  mrp: number | null;
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

    const resolved = await this.resolveProducts(rows.map((r) => r.productId));

    const seen = new Set<string>();
    const items: WishlistEntry[] = [];

    for (const row of rows) {
      const found = resolved.get(row.productId);

      // An id that resolves to nothing is a listing that has gone. Returning
      // it would render a blank card the buyer cannot act on.
      if (!found) continue;

      // Rows saved before ids were canonicalised can still hold a listing id
      // and a catalog id for the same product, which is what showed a product
      // twice in the saved list. The newest row wins; the older one is left
      // in place, doing no harm, and goes when its twin is removed.
      if (seen.has(found.catalogId)) continue;
      seen.add(found.catalogId);

      items.push({
        id: row.id,
        productId: row.productId,
        createdAt: row.createdAt.toISOString(),
        product: found.product,
      });
    }

    return { items, total: items.length };
  }

  /**
   * Saving the same item twice is a no-op rather than an error: the storefront
   * fires this optimistically and a duplicate tap must not surface a failure.
   */
  async add(userId: string, productId: string): Promise<WishlistEntry> {
    const [canonical] = await this.canonicalIds([productId]);

    const row = await this.prisma.wishlistItem.upsert({
      where: { userId_productId: { userId, productId: canonical } },
      update: {},
      create: { userId, productId: canonical },
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
   *
   * Both the id as given and the product it stands for are cleared, so
   * un-bookmarking from a product page also takes away a row that an older
   * build filed under a listing id.
   */
  async remove(userId: string, productId: string): Promise<{ removed: number }> {
    const [canonical] = await this.canonicalIds([productId]);
    const ids = Array.from(new Set([productId, canonical]));

    const { count } = await this.prisma.wishlistItem.deleteMany({
      where: { userId, productId: { in: ids } },
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

    const canonical = Array.from(new Set(await this.canonicalIds(unique)));

    const { count } = await this.prisma.wishlistItem.createMany({
      data: canonical.map((productId) => ({ userId, productId })),
      skipDuplicates: true,
    });
    return { added: count };
  }

  /**
   * The id a save is filed under: the CatalogProduct, always.
   *
   * Three surfaces save the same product. The product page and the grid hold
   * a CatalogProduct id; the cart drawer holds the SellerOffer id it needs
   * for checkout. Filed as they arrived, one product occupied two rows — so
   * it appeared twice in the saved list, each row resolved by a different
   * lookup below and so shown with different price and picture, and the
   * bookmark on the product page never lit for the copy saved from the cart
   * because that compares against the catalog id.
   *
   * An offer reaches a catalog product two ways: `catalogProductId` directly
   * (simple products) or `variantId` through a ProductVariant. An id that is
   * not an offer — already a catalog id, or something this cannot see — is
   * returned untouched.
   */
  private async canonicalIds(ids: string[]): Promise<string[]> {
    const unique = Array.from(new Set(ids));
    if (unique.length === 0) return [];

    const byOfferId = new Map<string, string>();
    try {
      const offers = await this.prisma.sellerOffer.findMany({
        where: { id: { in: unique } },
        select: {
          id: true,
          catalogProductId: true,
          variant: { select: { catalogProductId: true } },
        },
      });
      for (const offer of offers) {
        const catalogId =
          offer.catalogProductId ?? offer.variant?.catalogProductId;
        if (catalogId) byOfferId.set(offer.id, catalogId);
      }
    } catch (error) {
      // Storing the id as it arrived still saves the item; at worst it is the
      // duplicate this is here to prevent.
      this.logger.warn(
        `Could not canonicalise saved ids: ${(error as Error)?.message}`,
      );
    }

    return ids.map((id) => byOfferId.get(id) ?? id);
  }

  /**
   * Saved ids to displayable products.
   *
   * Saves are filed against a CatalogProduct, but rows written before that
   * may hold a SellerOffer id, so both are looked up and whichever answers
   * wins. Two queries plus one for prices, not one per item.
   */
  private async resolveProducts(
    ids: string[],
  ): Promise<Map<string, ResolvedSave>> {
    const found = new Map<string, ResolvedSave>();
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
          catalogProductId: true,
          // Read to decide `available`: this query deliberately does NOT filter
          // on them, because a save must still resolve to a card once its
          // listing goes away — it just stops being actionable.
          isActive: true,
          approvalStatus: true,
          deletedAt: true,
          // An offer reaches its catalog product either directly or through a
          // variant. Only the variant was read, so a listing made straight
          // against a product had no picture in the saved list.
          catalogProduct: {
            select: {
              id: true,
              slug: true,
              isActive: true,
              deletedAt: true,
              images: {
                select: { url: true },
                orderBy: [{ order: 'asc' }, { id: 'asc' }],
              },
            },
          },
          variant: {
            select: {
              catalogProduct: {
                select: {
                  id: true,
                  slug: true,
                  isActive: true,
                  deletedAt: true,
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
        const catalog = offer.variant?.catalogProduct ?? offer.catalogProduct;
        // Both halves have to hold: a live listing is not for sale if the
        // master it hangs off has been put back into Draft, which is exactly
        // how two Draft products came to sit in the saved list with a working
        // Add button.
        const listingLive =
          offer.isActive &&
          offer.approvalStatus === ProductApprovalStatus.APPROVED &&
          !offer.deletedAt;
        const masterLive = catalog ? catalog.isActive && !catalog.deletedAt : true;
        found.set(offer.id, {
          catalogId: catalog?.id ?? offer.id,
          product: {
            id: offer.id,
            name: offer.name,
            slug: catalog?.slug ?? null,
            // What a buyer would actually pay, falling back to the listed price.
            price: Number(offer.finalCustomerPayable ?? offer.mrp ?? 0),
            mrp: offer.mrp != null ? Number(offer.mrp) : null,
            images: (catalog?.images ?? []).map((i) => i.url),
            manufacturer: offer.manufacturer,
            // The row already holds a listing; that is the one to put in the bag.
            bestListingId: offer.id,
            available: listingLive && masterLive,
          },
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
            manufacturer: true,
            mrp: true,
            // Read, not filtered on: a Draft product stays in the saved list as
            // an unavailable card rather than disappearing out of it.
            isActive: true,
            images: {
              select: { url: true },
              orderBy: [{ order: 'asc' }, { id: 'asc' }],
            },
          },
        });

        const cheapest = await this.cheapestOfferPrices(
          catalogProducts.map((p) => p.id),
        );

        for (const product of catalogProducts) {
          const offer = cheapest.get(product.id);
          const mrp =
            offer?.mrp ?? (product.mrp != null ? Number(product.mrp) : null);
          found.set(product.id, {
            catalogId: product.id,
            product: {
              id: product.id,
              name: product.name,
              slug: product.slug,
              // A catalog product carries no price of its own that a buyer
              // could pay, so this used to be zero and the saved card read
              // "N/A" next to every item saved from a product page.
              price: offer?.price ?? mrp ?? 0,
              mrp,
              images: product.images.map((i) => i.url),
              manufacturer: product.manufacturer,
              bestListingId: offer?.id ?? null,
              // cheapestOfferPrices only returns live, approved listings, so no
              // offer means nothing is on sale even when the product is Active.
              available: product.isActive && offer != null,
            },
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

  /**
   * What each of these products currently sells for: the cheapest live offer,
   * the same one the grid prices a card from. Offers reach a product directly
   * or through a variant, and both count.
   */
  private async cheapestOfferPrices(
    catalogIds: string[],
  ): Promise<Map<string, CheapestOffer>> {
    const best = new Map<string, CheapestOffer>();
    if (catalogIds.length === 0) return best;

    const offers = await this.prisma.sellerOffer.findMany({
      where: {
        isActive: true,
        approvalStatus: ProductApprovalStatus.APPROVED,
        deletedAt: null,
        OR: [
          { catalogProductId: { in: catalogIds } },
          { variant: { catalogProductId: { in: catalogIds } } },
        ],
      },
      select: {
        id: true,
        mrp: true,
        finalCustomerPayable: true,
        catalogProductId: true,
        variant: { select: { catalogProductId: true } },
      },
    });

    for (const offer of offers) {
      const catalogId =
        offer.catalogProductId ?? offer.variant?.catalogProductId;
      if (!catalogId) continue;

      const price = Number(offer.finalCustomerPayable ?? offer.mrp ?? 0);
      if (price <= 0) continue;

      const current = best.get(catalogId);
      if (!current || price < current.price) {
        best.set(catalogId, {
          id: offer.id,
          price,
          mrp: offer.mrp != null ? Number(offer.mrp) : null,
        });
      }
    }

    return best;
  }
}
