import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { AddToCartDto } from './dto/add-to-cart.dto';
import { UpdateCartItemDto } from './dto/update-cart-item.dto';

@Injectable()
export class CartService {
  private readonly logger = new Logger(CartService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ──────────────────────────────────────────────
  // ADD TO CART
  // ──────────────────────────────────────────────

  async addToCart(userId: string, dto: AddToCartDto) {
    let { sellerOfferId, quantity } = dto;

    // 1. Validate product exists, is active, and not soft-deleted
    let sellerOffer = await this.prisma.sellerOffer.findFirst({
      where: { id: sellerOfferId, isActive: true, deletedAt: null },
      include: {
        batches: {
          where: { stock: { gt: 0 } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!sellerOffer) {
      // Fallback: If a CatalogProduct ID was passed, find its best active SellerOffer
      const catalogProduct = await this.prisma.catalogProduct.findFirst({
        where: { id: sellerOfferId, deletedAt: null },
        include: {
          productVariants: {
            include: {
              sellerOffers: {
                where: { isActive: true, deletedAt: null },
                include: {
                  batches: {
                    where: { stock: { gt: 0 } },
                    orderBy: { createdAt: 'asc' },
                  },
                },
                orderBy: { finalCustomerPayable: 'asc' },
              },
            },
          },
        },
      });
      if (catalogProduct && catalogProduct.productVariants.length > 0) {
        const offers = catalogProduct.productVariants.flatMap(
          (v: any) => v.sellerOffers || [],
        );
        if (offers.length > 0) {
          sellerOffer = offers.reduce((prev: any, curr: any) =>
            (prev.finalCustomerPayable ?? prev.mrp) < (curr.finalCustomerPayable ?? curr.mrp) ? prev : curr,
          );
          sellerOfferId = sellerOffer!.id;
        }
      }
    }

    if (!sellerOffer) {
      throw new NotFoundException(
        'Product not found or is no longer available',
      );
    }

    // 2b. The listing can be live while the product it belongs to is in Draft.
    // Only findAll() ever checked that, so a Draft product stayed buyable
    // through every by-id route — the saved list offered an Add for one and
    // the bag accepted it. Resolved through both links an offer can take to
    // its master; a master that cannot be found at all is left alone, so an
    // orphaned listing behaves exactly as it did before.
    const master = await this.prisma.catalogProduct.findFirst({
      where: {
        OR: [
          { sellerOffers: { some: { id: sellerOffer.id } } },
          { productVariants: { some: { sellerOffers: { some: { id: sellerOffer.id } } } } },
        ],
      },
      select: { isActive: true, deletedAt: true },
    });
    if (master && (!master.isActive || master.deletedAt)) {
      throw new BadRequestException(
        'This product is not available for purchase right now',
      );
    }

    // 3. Validate minimum order quantity
    if (quantity < sellerOffer.minimumOrderQuantity) {
      throw new BadRequestException(
        `Minimum order quantity for this product is ${sellerOffer.minimumOrderQuantity}`,
      );
    }

    // 4. Validate maximum order quantity
    if (
      sellerOffer.maximumOrderQuantity &&
      quantity > sellerOffer.maximumOrderQuantity
    ) {
      throw new BadRequestException(
        `Maximum order quantity for this product is ${sellerOffer.maximumOrderQuantity}`,
      );
    }

    // 5. Validate stock availability across all batches
    const totalStock = sellerOffer.batches.reduce((sum, b) => sum + b.stock, 0);
    if (quantity > totalStock) {
      throw new BadRequestException(
        `Insufficient stock. Only ${totalStock} units available`,
      );
    }

    // 6. Get or create cart
    let cart = await this.prisma.cart.findUnique({
      where: { userId },
    });

    if (!cart) {
      cart = await this.prisma.cart.create({
        data: { userId },
      });
      this.logger.log(`Cart created for user ${userId}`);
    }

    // 7. Check for duplicate product in cart
    const existingItem = await this.prisma.cartItem.findUnique({
      where: { cartId_sellerOfferId: { cartId: cart.id, sellerOfferId } },
    });

    if (existingItem) {
      throw new BadRequestException(
        'Product already in cart. Use PATCH /api/cart/item/:id to update quantity.',
      );
    }

    // 8. Snapshot the unit price (MRP or finalCustomerPayable)
    const unitPrice = sellerOffer.finalCustomerPayable ?? sellerOffer.mrp;

    // 9. Create cart item
    const cartItem = await this.prisma.cartItem.create({
      data: {
        cartId: cart.id,
        sellerOfferId,
        quantity,
        unitPrice,
      },
      include: {
        sellerOffer: {
          select: {
            id: true,
            name: true,
            manufacturer: true,
            mrp: true,
                finalCustomerPayable: true,
            minimumOrderQuantity: true,
            maximumOrderQuantity: true,
                shippingCharges: true,
                finalShippingPrice: true,

            batches: {
              where: { stock: { gt: 0 } },
              select: { stock: true },
            },

            catalogProduct: {
              select: {
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
                    images: {
                      select: { url: true },
                      orderBy: [{ order: 'asc' }, { id: 'asc' }],
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    this.logger.log(
      `Item added to cart: product ${sellerOfferId}, qty ${quantity}`,
    );

    return {
      ...cartItem,
      sellerOffer: this.formatCartItemOffer(cartItem.sellerOffer),
      totalPrice: (cartItem.quantity * Number(cartItem.unitPrice)) + (cartItem.quantity * (Number(cartItem.sellerOffer.finalShippingPrice ?? cartItem.sellerOffer.shippingCharges) || 0)),
    };
  }

  // ──────────────────────────────────────────────
  // GET CART
  // ──────────────────────────────────────────────

  async getCart(userId: string) {
    const cart = await this.prisma.cart.findUnique({
      where: { userId },
      include: {
        items: {
          include: {
            sellerOffer: {
              select: {
                id: true,
                name: true,
                manufacturer: true,

                mrp: true,
                finalCustomerPayable: true,
                gstPercent: true,
                minimumOrderQuantity: true,
                maximumOrderQuantity: true,
                shippingCharges: true,
                finalShippingPrice: true,

                isActive: true,
                deletedAt: true,

                batches: {
                  where: { stock: { gt: 0 } },
                  select: { stock: true },
                },

                catalogProduct: {
                  select: {
                    // Read so a line whose product went Draft after it was
                    // added goes stale instead of checking out.
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
                seller: {
                  select: {
                    id: true,
                    companyName: true,
                    city: true,
                    state: true,
                    rating: true,
                  },
                },
              },
            },
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!cart || cart.items.length === 0) {
      return {
        cartId: cart?.id ?? null,
        items: [],
        totalAmount: 0,
      };
    }

    // Silently drop items whose listing is no longer purchasable (deactivated,
    // soft-deleted, or fully out of stock) instead of returning them as if
    // nothing changed — and delete the stale rows so they can't resurface via
    // the pre-checkout local-cart sync (useSyncCart on the buyer app), which
    // checks "does this item already exist in the backend cart" by id.
    const staleItemIds: string[] = [];
    const liveCartItems = cart.items.filter((item) => {
      const stock = item.sellerOffer.batches.reduce((sum, b) => sum + b.stock, 0);
      // The master counts as well as the listing. A product put back into
      // Draft stops being for sale, and a line already in the bag must not be
      // the one route left that still checks out.
      const master =
        item.sellerOffer.variant?.catalogProduct ?? item.sellerOffer.catalogProduct;
      const masterGone = !!master && (!master.isActive || !!master.deletedAt);
      const isStale =
        !item.sellerOffer.isActive ||
        !!item.sellerOffer.deletedAt ||
        masterGone ||
        stock <= 0;
      if (isStale) staleItemIds.push(item.id);
      return !isStale;
    });
    if (staleItemIds.length > 0) {
      await this.prisma.cartItem.deleteMany({ where: { id: { in: staleItemIds } } });
    }

    if (liveCartItems.length === 0) {
      return {
        cartId: cart.id,
        items: [],
        totalAmount: 0,
      };
    }

    const items = await Promise.all(
      liveCartItems.map(async (item) => ({
        id: item.id,
        sellerOffer: this.formatCartItemOffer(item.sellerOffer),
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        totalPrice: (item.quantity * Number(item.unitPrice)) + (item.quantity * (Number(item.sellerOffer.finalShippingPrice ?? item.sellerOffer.shippingCharges) || 0)),
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      })),
    );

    const totalAmount = items.reduce((sum, item) => sum + item.totalPrice, 0);

    return {
      cartId: cart.id,
      items,
      totalAmount,
    };
  }

  // ──────────────────────────────────────────────
  // UPDATE CART ITEM QUANTITY
  // ──────────────────────────────────────────────

  async updateCartItem(
    userId: string,
    cartItemId: string,
    dto: UpdateCartItemDto,
  ) {
    const { quantity } = dto;

    // 1. Find the cart item and verify ownership
    const cartItem = await this.prisma.cartItem.findUnique({
      where: { id: cartItemId },
      include: {
        cart: { select: { userId: true } },
        sellerOffer: {
          include: {
            batches: { where: { stock: { gt: 0 } } },
            catalogProduct: { select: { isActive: true, deletedAt: true } },
            variant: {
              select: {
                catalogProduct: { select: { isActive: true, deletedAt: true } },
              },
            },
          },
        },
      },
    });

    if (!cartItem) {
      throw new NotFoundException('Cart item not found');
    }

    if (cartItem.cart.userId !== userId) {
      throw new NotFoundException('Cart item not found');
    }

    // 2. Validate product is still active — the master as well as the listing,
    // so raising the quantity on a product that has gone Draft is refused too.
    const master =
      cartItem.sellerOffer.variant?.catalogProduct ??
      cartItem.sellerOffer.catalogProduct;
    if (
      !cartItem.sellerOffer.isActive ||
      cartItem.sellerOffer.deletedAt ||
      (master && (!master.isActive || master.deletedAt))
    ) {
      throw new BadRequestException('This product is no longer available');
    }

    // 3. Validate minimum order quantity
    if (quantity < cartItem.sellerOffer.minimumOrderQuantity) {
      throw new BadRequestException(
        `Minimum order quantity for this product is ${cartItem.sellerOffer.minimumOrderQuantity}`,
      );
    }

    // 4. Validate maximum order quantity
    if (
      cartItem.sellerOffer.maximumOrderQuantity &&
      quantity > cartItem.sellerOffer.maximumOrderQuantity
    ) {
      throw new BadRequestException(
        `Maximum order quantity for this product is ${cartItem.sellerOffer.maximumOrderQuantity}`,
      );
    }

    // 5. Validate stock
    const totalStock = cartItem.sellerOffer.batches.reduce(
      (sum, b) => sum + b.stock,
      0,
    );
    if (quantity > totalStock) {
      throw new BadRequestException(
        `Insufficient stock. Only ${totalStock} units available`,
      );
    }

    // 6. Update quantity
    const updated = await this.prisma.cartItem.update({
      where: { id: cartItemId },
      data: { quantity },
      include: {
        sellerOffer: {
          select: {
            id: true,
            name: true,
            manufacturer: true,
            mrp: true,
                finalCustomerPayable: true,
minimumOrderQuantity: true,
            maximumOrderQuantity: true,
                shippingCharges: true,
                finalShippingPrice: true,

            batches: {
              where: { stock: { gt: 0 } },
              select: { stock: true },
            },

            catalogProduct: {
              select: {
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
                    images: {
                      select: { url: true },
                      orderBy: [{ order: 'asc' }, { id: 'asc' }],
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    this.logger.log(`Cart item ${cartItemId} quantity updated to ${quantity}`);

    return {
      ...updated,
      sellerOffer: this.formatCartItemOffer(updated.sellerOffer),
      totalPrice: (updated.quantity * Number(updated.unitPrice)) + (updated.quantity * (Number(updated.sellerOffer.finalShippingPrice ?? updated.sellerOffer.shippingCharges) || 0)),
    };
  }

  // ──────────────────────────────────────────────
  // REMOVE SINGLE ITEM
  // ──────────────────────────────────────────────

  async removeCartItem(userId: string, cartItemId: string) {
    // Verify ownership
    const cartItem = await this.prisma.cartItem.findUnique({
      where: { id: cartItemId },
      include: { cart: { select: { userId: true } } },
    });

    if (!cartItem) {
      throw new NotFoundException('Cart item not found');
    }

    if (cartItem.cart.userId !== userId) {
      throw new NotFoundException('Cart item not found');
    }

    await this.prisma.cartItem.delete({
      where: { id: cartItemId },
    });

    this.logger.log(`Cart item ${cartItemId} removed`);
    return { message: 'Item removed from cart' };
  }

  // ──────────────────────────────────────────────
  // CLEAR ENTIRE CART
  // ──────────────────────────────────────────────

  async clearCart(userId: string) {
    const cart = await this.prisma.cart.findUnique({
      where: { userId },
    });

    if (!cart) {
      return { message: 'Cart is already empty' };
    }

    await this.prisma.cartItem.deleteMany({
      where: { cartId: cart.id },
    });

    this.logger.log(`Cart cleared for user ${userId}`);
    return { message: 'Cart cleared successfully' };
  }

  /**
   * An offer reaches a catalog product two ways — `catalogProductId` directly
   * (simple products) or `variantId` through a ProductVariant. Only the second
   * was read here; the gap was filled by finding a product whose name merely
   * *starts with* the offer's, which put one product's photograph on another
   * product's cart line ("Testing" matches "Testing - Iron man"). The offer's
   * own link is the only thing consulted now, and an offer linked to nothing
   * carries no image rather than someone else's.
   */
  private formatCartItemOffer(sellerOffer: any) {
    if (!sellerOffer) return sellerOffer;

    const linked =
      sellerOffer.variant?.catalogProduct ?? sellerOffer.catalogProduct;
    const images: string[] = (linked?.images ?? []).map(
      (img: any) => img.url as string,
    );

    // Remove variant/catalogProduct/batches to keep the response clean, attach
    // a flat images array and the total available stock summed across in-stock
    // batches.
    const { variant, catalogProduct, batches, ...rest } = sellerOffer;
    return {
      ...rest,
      images,
      // Left undefined (not 0) when batches were not selected, so the client
      // falls back to "unbounded" rather than wrongly showing out of stock.
      stock: Array.isArray(batches)
        ? batches.reduce((sum: number, b: any) => sum + b.stock, 0)
        : undefined,
    };
  }
}
