import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { CreateReviewDto } from './dto/create-review.dto';
import { QueryAdminReviewsDto, QuerySellerReviewsDto } from './dto/query-reviews.dto';

@Injectable()
export class ReviewsService {
  private readonly logger = new Logger(ReviewsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolve a catalog product by ID or slug, the same way the buyer app's
   * product page URL can carry either.
   */
  private async resolveProduct(catalogProductId: string) {
    let product = await this.prisma.catalogProduct.findUnique({
      where: { id: catalogProductId },
    });

    if (!product) {
      product = await this.prisma.catalogProduct.findFirst({
        where: {
          OR: [{ id: catalogProductId }, { slug: catalogProductId }],
          deletedAt: null,
        },
      });
    }

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    return product;
  }

  /**
   * The order line that makes this buyer eligible to review the product,
   * matching either a direct listing or a variant of one.
   */
  private async findPurchase(userId: string, resolvedProductId: string) {
    return this.prisma.orderItem.findFirst({
      where: {
        OR: [
          { sellerOffer: { catalogProductId: resolvedProductId } },
          { sellerOffer: { variant: { catalogProductId: resolvedProductId } } },
        ],
        order: {
          buyerId: userId,
          orderStatus: { not: 'CANCELLED' },
        },
      },
    });
  }

  /**
   * Whether a buyer may review a product right now: purchased it, and
   * hasn't already reviewed it. Lets the buyer app tell someone up front
   * that they need a purchase, rather than only after they've written a
   * full review and hit submit.
   */
  async getEligibility(userId: string, catalogProductId: string) {
    const product = await this.resolveProduct(catalogProductId);
    const purchased = await this.findPurchase(userId, product.id);

    if (!purchased) {
      return { canReview: false, reason: 'NOT_PURCHASED' as const };
    }

    const existing = await this.prisma.review.findUnique({
      where: { userId_catalogProductId: { userId, catalogProductId: product.id } },
    });

    if (existing) {
      return { canReview: false, reason: 'ALREADY_REVIEWED' as const };
    }

    return { canReview: true, reason: null };
  }

  /**
   * Create a review. Only buyers who purchased the product may review it.
   * One review per user per product (enforced by @@unique([userId, productId])).
   */
  async createReview(userId: string, dto: CreateReviewDto) {
    const { catalogProductId, rating, comment } = dto;

    const product = await this.resolveProduct(catalogProductId);
    const resolvedProductId = product.id;

    // Verify buyer has purchased this product (matches direct catalogProductId or variant catalogProductId)
    const purchased = await this.findPurchase(userId, resolvedProductId);

    if (!purchased) {
      throw new BadRequestException(
        'You can only review products you have purchased',
      );
    }

    // Check for existing review
    const existing = await this.prisma.review.findUnique({
      where: { userId_catalogProductId: { userId, catalogProductId: resolvedProductId } },
    });

    if (existing) {
      throw new ConflictException('You have already reviewed this product');
    }

    const review = await this.prisma.review.create({
      data: {
        userId,
        catalogProductId: resolvedProductId,
        sellerOfferId: purchased.sellerOfferId,
        rating,
        comment,
        images: dto.images || [],
      },
      select: {
        id: true,
        userId: true,
        catalogProductId: true,
        rating: true,
        comment: true,
        images: true,
        createdAt: true,
      },
    });

    // Update seller's average rating
    await this.updateSellerRating(purchased.sellerId);

    this.logger.log(
      `Review created by user ${userId} for product ${catalogProductId}: ${rating}/5`,
    );

    return review;
  }

  /**
   * Get all reviews for a catalogProduct.
   */
  async getProductReviews(catalogProductId: string) {
    const product = await this.prisma.catalogProduct.findUnique({
      where: { id: catalogProductId },
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    const reviews = await this.prisma.review.findMany({
      where: { catalogProductId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        rating: true,
        comment: true,
        images: true,
        createdAt: true,
        user: {
          select: {
            id: true,
            buyerProfile: {
              select: { legalName: true, city: true },
            },
          },
        },
      },
    });

    // Compute average rating
    const avgResult = await this.prisma.review.aggregate({
      where: { catalogProductId },
      _avg: { rating: true },
      _count: true,
    });

    return {
      data: reviews.map((r) => ({
        id: r.id,
        catalogProductId: catalogProductId,
        userId: r.user.id,
        userName: r.user.buyerProfile?.legalName || 'User',
        rating: r.rating,
        comment: r.comment || '',
        images: r.images || [],
        createdAt: r.createdAt.toISOString(),
      })),
      total: avgResult._count || 0,
      averageRating: +((avgResult._avg && avgResult._avg.rating) || 0).toFixed(
        1,
      ),
      page: 1,
      limit: 50,
    };
  }

  /**
   * Get all reviews for admin dashboard.
   */
  /**
   * Shared filter builder for the admin review list.
   *
   * A catalog product can be sold by several sellers, so seller scoping goes
   * through the REVIEW'S OWN sellerOffer (the listing actually purchased) —
   * never "products this seller also sells", which would attribute a rival's
   * review to them.
   */
  private buildReviewWhere(q: {
    sellerId?: string;
    productId?: string;
    userId?: string;
    categoryId?: string;
    dateFrom?: string;
    dateTo?: string;
    rating?: number;
    search?: string;
  }): Record<string, unknown> {
    const where: Record<string, unknown> = {};
    if (q.productId) where.catalogProductId = q.productId;
    if (q.userId) where.userId = q.userId;
    if (q.rating) where.rating = q.rating;
    if (q.sellerId) where.sellerOffer = { sellerId: q.sellerId };
    if (q.categoryId) {
      where.catalogProduct = {
        OR: [
          { categoryId: q.categoryId },
          { extraCategories: { some: { id: q.categoryId } } },
        ],
      };
    }
    if (q.dateFrom || q.dateTo) {
      const createdAt: Record<string, Date> = {};
      if (q.dateFrom) createdAt.gte = new Date(q.dateFrom);
      if (q.dateTo) {
        // Inclusive end-of-day so "to 5 Sep" includes the 5th.
        const to = new Date(q.dateTo);
        to.setHours(23, 59, 59, 999);
        createdAt.lte = to;
      }
      where.createdAt = createdAt;
    }
    if (q.search?.trim()) {
      const search = q.search.trim();
      where.OR = [
        { comment: { contains: search, mode: 'insensitive' } },
        { catalogProduct: { name: { contains: search, mode: 'insensitive' } } },
      ];
    }
    return where;
  }

  async getAdminReviews(query: QueryAdminReviewsDto = {}) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    try {
      if ((this.prisma as any).review) {
        const where = this.buildReviewWhere(query);
        const [reviews, total] = await Promise.all([
          (this.prisma as any).review.findMany({
            where,
            skip: (page - 1) * limit,
            take: limit,
            orderBy: { createdAt: 'desc' },
            include: {
              catalogProduct: {
                select: { name: true, category: { select: { id: true, name: true } } },
              },
              sellerOffer: {
                select: { sellerId: true, seller: { select: { companyName: true } } },
              },
              user: {
                select: {
                  id: true,
                  email: true,
                  buyerProfile: { select: { legalName: true } },
                },
              },
            },
          }),
          (this.prisma as any).review.count({ where }),
        ]);

        return {
          data: reviews.map((r: any) => ({
            id: r.id,
            catalogProductId: r.catalogProductId,
            productName: r.catalogProduct?.name || 'Unknown Product',
            categoryId: r.catalogProduct?.category?.id ?? null,
            categoryName: r.catalogProduct?.category?.name ?? null,
            sellerId: r.sellerOffer?.sellerId ?? null,
            sellerName: r.sellerOffer?.seller?.companyName ?? null,
            userId: r.userId,
            userName: r.user.buyerProfile?.legalName || r.user.email || 'User',
            rating: r.rating,
            comment: r.comment || '',
            images: r.images || [],
            createdAt: r.createdAt.toISOString(),
          })),
          total: total || 0,
          page,
          limit,
          totalPages: Math.ceil((total || 0) / limit),
        };
      }
    } catch (error) {
      this.logger.warn(`Failed to fetch admin reviews: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
    return { data: [], total: 0, page, limit, totalPages: 0 };
  }

  /**
   * Reviews for ONE seller's own listings.
   *
   * Scoped by the purchased listing's sellerId, so a seller sees only reviews
   * left by buyers who bought from THEM — never another seller's reviews of
   * the same catalog product. Buyer identity is deliberately omitted from the
   * response (sellers filter by product/category/date, never by customer).
   */
  async getSellerReviews(userId: string, query: QuerySellerReviewsDto = {}) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));

    const seller = await this.prisma.sellerProfile.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!seller) throw new NotFoundException('Seller profile not found');

    const where = this.buildReviewWhere({ ...query, sellerId: seller.id });

    const [reviews, total, agg] = await Promise.all([
      (this.prisma as any).review.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          catalogProduct: {
            select: { id: true, name: true, category: { select: { id: true, name: true } } },
          },
        },
      }),
      (this.prisma as any).review.count({ where }),
      (this.prisma as any).review.aggregate({
        where: { sellerOffer: { sellerId: seller.id } },
        _avg: { rating: true },
        _count: true,
      }),
    ]);

    return {
      data: reviews.map((r: any) => ({
        id: r.id,
        catalogProductId: r.catalogProductId,
        productName: r.catalogProduct?.name || 'Unknown Product',
        categoryId: r.catalogProduct?.category?.id ?? null,
        categoryName: r.catalogProduct?.category?.name ?? null,
        rating: r.rating,
        comment: r.comment || '',
        images: r.images || [],
        createdAt: r.createdAt.toISOString(),
        // No buyer identity by design.
      })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      summary: {
        average: agg._avg.rating ? Math.round(agg._avg.rating * 10) / 10 : null,
        count: typeof agg._count === 'number' ? agg._count : 0,
      },
    };
  }

  /**
   * Delete a review (Admin).
   */
  async deleteReview(reviewId: string) {
    const review = await this.prisma.review.findUnique({
      where: { id: reviewId },
      include: { sellerOffer: true },
    });

    if (!review) {
      throw new NotFoundException('Review not found');
    }

    await this.prisma.review.delete({
      where: { id: reviewId },
    });

    if (review.sellerOffer?.sellerId) {
      await this.updateSellerRating(review.sellerOffer.sellerId);
    }

    this.logger.log(`Review ${reviewId} deleted by Admin`);
    return { success: true, message: 'Review deleted successfully' };
  }

  /**
   * Recalculate and update the seller's average rating.
   */
  private async updateSellerRating(sellerId: string) {
    const result = await this.prisma.review.aggregate({
      where: { sellerOffer: { sellerId } },
      _avg: { rating: true },
    });

    const avgRating = +((result._avg && result._avg.rating) || 0).toFixed(1);

    await this.prisma.sellerProfile.update({
      where: { id: sellerId },
      data: { rating: avgRating },
    });
  }
}
