import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import csv from 'csv-parser';
import { Readable } from 'stream';
import slugify from 'slugify';
import { buildPayoutInputFromOrderItem, calculateSellerPayout } from '../settlements/payout-calculator';
import { AdminQuerySuggestionsDto } from './dto/query-suggestions.dto';
import { AdminUpdateProductDto } from './dto/admin-update-product.dto';
import { applySlugChange, SlugPrisma } from './product-slug';
import {
  UserStatus,
  OrderStatus,
  PaymentStatus,
  PaymentVerificationStatus,
  ProductApprovalStatus,
  TicketStatus,
  Prisma,
  Role,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import {
  ACCESS_LEVELS,
  AdminGrants,
  AccessLevel,
  SUPER_GRANTS,
  TAB_GROUPS,
  TabKey,
  grantsFromInput,
  isTabKey,
  parseAdminGrants,
  serializeAdminGrants,
} from '../../common/admin-access';
import { OrdersService } from '../orders/orders.service';
import { QueryUsersDto } from './dto/query-users.dto';
import { AdminQueryProductsDto } from './dto/query-products.dto';
import { AdminQueryOrdersDto } from './dto/query-orders.dto';
import { AdminQueryPaymentsDto } from './dto/query-payments.dto';
import { AdminQuerySettlementsDto } from './dto/query-settlements.dto';
import { AdminQueryTicketsDto } from './dto/query-tickets.dto';
import { AdminUpdateOrderStatusDto } from './dto/admin-update-order-status.dto';
import { AdminUpdateTicketStatusDto } from './dto/admin-update-ticket-status.dto';
import { AdminReplyTicketDto } from './dto/admin-reply-ticket.dto';
import { NotificationsService } from '../notifications/notifications.service';
import { SellersService } from '../sellers/sellers.service';
import { UpdateSellerProfileDto } from '../sellers/dto/update-seller-profile.dto';
import { MailService } from '../mail/mail.service';
import { PayoutEmailService } from '../settlements/payout-email.service';
import { ProductsService } from '../products/products.service';
import { AdminCreateProductDto } from './dto/admin-create-product.dto';

// Fallback for the known internal test/QA buyer account(s) (e.g. manual
// payment-gateway testing) if TEST_BUYER_PHONES is not set in the
// environment — same config-first-with-hardcoded-fallback convention as
// OtpSmsService's Nimbus credentials. Kept as a plain string (not an array)
// so the env var can be a comma-separated list; getTestBuyerPhones() below
// does the splitting. A phone number, unlike a code constant, is otherwise
// stuck in git history forever with no way to rotate it without a deploy.
const DEFAULT_TEST_BUYER_PHONES = '8500237151';

// Settings are a flat key/value store and most of it is harmless copy, but the
// Instagram token is a credential. It is masked on the way out and the mask is
// ignored on the way back in; see getPlatformSettings/updatePlatformSettings.
const INSTAGRAM_TOKEN_KEY = 'instagramAccessToken';
const MASKED_SECRET = '••••••••';

/**
 * Per-order overrides of the test/real split.
 *
 * TEST_BUYER_PHONES classifies by WHO placed an order, which cannot express
 * "these two are real orders, everything else from that number was me
 * testing" — and that is the situation an admin actually ends up in. These
 * two lists hold the exceptions and they win over the phone rule.
 *
 * Kept in SystemSetting rather than a column on Order because the deploy runs
 * `prisma generate` but never `prisma migrate deploy`: a new column would
 * exist in the Prisma client and not in the database.
 */
const REAL_ORDER_IDS_KEY = 'realOrderIds';
const TEST_ORDER_IDS_KEY = 'testOrderIds';

export type OrderClassification = 'real' | 'test' | 'auto';

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
    private readonly ordersService: OrdersService,
    private readonly sellersService: SellersService,
    private readonly mailService: MailService,
    private readonly productsService: ProductsService,
    private readonly configService: ConfigService,
    // Appended, never inserted: the specs construct this service positionally,
    // so changing the existing order would break them silently.
    private readonly payoutEmailService: PayoutEmailService,
  ) {}

  /**
   * Known internal test/QA buyer account(s) — their orders are real rows in
   * the DB (never delete them) but are excluded by default from admin order
   * views/totals so they don't pollute Order Monitoring or the Dashboard.
   * Identified by exact phone number rather than any name-based heuristic,
   * since a real buyer's self-entered legal name could plausibly start with
   * "test" (e.g. "Testline Diagnostics") and get silently hidden.
   * Comma-separated in TEST_BUYER_PHONES so a future second test account
   * doesn't require a code change, just an env var update.
   */
  private getTestBuyerPhones(): string[] {
    return (this.configService.get<string>('TEST_BUYER_PHONES') || DEFAULT_TEST_BUYER_PHONES)
      .split(',')
      .map((phone) => phone.trim())
      .filter(Boolean);
  }

  /**
   * The set of test-buyer orders a bulk cancel would actually attempt:
   * not already in a terminal state, and not already carrying a confirmed
   * payment (OrdersService.cancelOrder refuses those anyway - filtering
   * them out here just skips a guaranteed-failure call per such order).
   */
  /**
   * The per-order exceptions to the phone rule. Unreadable settings degrade to
   * "no overrides" — the phone rule alone — rather than failing an orders list.
   */
  private async getOrderOverrides(): Promise<{ real: string[]; test: string[] }> {
    const parse = (value?: string) =>
      (value ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean);

    try {
      const rows = await this.prisma.systemSetting.findMany({
        where: { key: { in: [REAL_ORDER_IDS_KEY, TEST_ORDER_IDS_KEY] } },
      });
      const byKey = new Map(rows.map((r) => [r.key, r.value]));
      return {
        real: parse(byKey.get(REAL_ORDER_IDS_KEY)),
        test: parse(byKey.get(TEST_ORDER_IDS_KEY)),
      };
    } catch (error) {
      this.logger.warn(
        `Could not read order classification overrides: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      return { real: [], test: [] };
    }
  }

  /** Is this order a test one, by the phone rule plus any override on it. */
  private classify(
    order: { id: string; buyer?: { phone?: string | null } | null },
    testPhones: string[],
    overrides: { real: string[]; test: string[] },
  ): { isTest: boolean; classification: OrderClassification } {
    if (overrides.real.includes(order.id)) return { isTest: false, classification: 'real' };
    if (overrides.test.includes(order.id)) return { isTest: true, classification: 'test' };
    const phone = order.buyer?.phone ?? '';
    return { isTest: testPhones.includes(phone), classification: 'auto' };
  }

  /**
   * "Not a test order", as one filter every caller shares.
   *
   * The phone rule used to be written out at each call site, so the orders
   * list and the dashboard could — and did — disagree about the same order:
   * marking one real brought it into the list while Total Orders and Platform
   * Revenue still ignored it. One definition, used everywhere, is what stops
   * that happening again.
   */
  private async notTestOrderWhere(): Promise<Prisma.OrderWhereInput> {
    const testPhones = this.getTestBuyerPhones();
    const { real, test } = await this.getOrderOverrides();
    return {
      OR: [
        ...(real.length ? [{ id: { in: real } }] : []),
        {
          AND: [
            { buyer: { phone: { notIn: testPhones } } },
            ...(test.length ? [{ id: { notIn: test } }] : []),
          ],
        },
      ],
    };
  }

  private async cancellableTestOrdersWhere(): Promise<Prisma.OrderWhereInput> {
    const uncancelable: OrderStatus[] = [
      OrderStatus.SHIPPED,
      OrderStatus.DELIVERED,
      OrderStatus.RETURNED,
      OrderStatus.CANCELLED,
    ];
    const overrides = await this.getOrderOverrides();
    return {
      // An order an admin has marked REAL is never swept up by the bulk
      // cancel, whoever placed it. That guarantee is the whole point of the
      // override — losing a genuine customer order to a test cleanup would be
      // unrecoverable.
      ...(overrides.real.length ? { id: { notIn: overrides.real } } : {}),
      OR: [
        { buyer: { phone: { in: this.getTestBuyerPhones() } } },
        ...(overrides.test.length ? [{ id: { in: overrides.test } }] : []),
      ],
      orderStatus: { notIn: uncancelable },
      paymentStatus: { notIn: [PaymentStatus.SUCCESS, PaymentStatus.PARTIAL] },
    };
  }

  /**
   * How many orders a call to cancelAllTestOrders() would attempt right
   * now, so the admin UI can show a count before the admin confirms the
   * bulk cancel rather than committing to it blind.
   */
  async countCancellableTestOrders(): Promise<number> {
    return this.prisma.order.count({ where: await this.cancellableTestOrdersWhere() });
  }

  /**
   * Bulk-cancels every order placed by the internal test/QA buyer account(s)
   * that isn't already in a terminal state, restoring stock for each. Reuses
   * OrdersService.cancelOrder one order at a time (role ADMIN bypasses its
   * buyer-ownership check) rather than writing a separate bulk query, so
   * this gets the exact same guards for free - it will not touch an order
   * whose payment has actually succeeded, and it restores stock the same
   * way a manual cancel does.
   *
   * A one-off cleanup action, not a scheduled sweep: test orders are
   * created deliberately for ongoing QA, so nothing should auto-cancel them
   * while someone is mid-test - this only runs when an admin asks for it.
   */
  async cancelAllTestOrders(): Promise<{
    cancelled: number;
    failed: number;
    total: number;
  }> {
    const testOrders = await this.prisma.order.findMany({
      where: await this.cancellableTestOrdersWhere(),
      select: { id: true, buyerId: true },
    });

    let cancelled = 0;
    let failed = 0;

    for (const order of testOrders) {
      try {
        await this.ordersService.cancelOrder(order.buyerId, order.id, Role.ADMIN);
        cancelled++;
      } catch (error: any) {
        failed++;
        this.logger.warn(
          `Could not cancel test order ${order.id} in bulk cleanup: ${error?.message}`,
        );
      }
    }

    this.logger.log(
      `Bulk test-order cleanup: ${cancelled} cancelled, ${failed} failed, ${testOrders.length} total`,
    );

    return { cancelled, failed, total: testOrders.length };
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // DASHBOARD
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  async getDashboard(params: { dateFrom?: string; dateTo?: string } = {}) {
    try {
      const dateWhere: any = {};

      if (params?.dateFrom) {
        const parsedFrom = new Date(params.dateFrom);
        if (!isNaN(parsedFrom.getTime())) {
          dateWhere.createdAt = dateWhere.createdAt || {};
          dateWhere.createdAt.gte = parsedFrom;
        }
      }

      if (params?.dateTo) {
        const parsedTo = new Date(params.dateTo);
        if (!isNaN(parsedTo.getTime())) {
          dateWhere.createdAt = dateWhere.createdAt || {};
          dateWhere.createdAt.lte = parsedTo;
        }
      }

      // Read once and shared by every order figure below, so Total Orders,
      // Platform Revenue, Pending Orders and Recent Orders can never disagree
      // with each other — or with the orders list — about what counts.
      const notTestOrder = await this.notTestOrderWhere();

      const safeQuery = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
        try {
          return await fn();
        } catch {
          return fallback;
        }
      };

      const [
        totalUsers,
        totalBuyers,
        totalSellers,
        totalOrders,
        revenueResult,
        pendingOrders,
        pendingPayments,
        pendingSettlements,
        totalProducts,
        openTickets,
        blockedUsers,
        recentOrders,
        referralStats,
        pendingProductRequests,
      ] = await Promise.all([
        safeQuery(() => this.prisma.user.count({ where: dateWhere }), 0),
        safeQuery(() => this.prisma.user.count({ where: { role: 'BUYER', ...dateWhere } }), 0),
        safeQuery(() => this.prisma.user.count({ where: { role: 'SELLER', ...dateWhere } }), 0),
        safeQuery(
          () =>
            this.prisma.order.count({
              where: { ...dateWhere, AND: [notTestOrder] },
            }),
          0,
        ),
        safeQuery(
          () =>
            this.prisma.order.aggregate({
              where: {
                paymentStatus: PaymentStatus.SUCCESS,
                orderStatus: { notIn: [OrderStatus.CANCELLED, OrderStatus.RETURNED] },
                AND: [notTestOrder],
                ...dateWhere,
              },
              _sum: { totalAmount: true },
            }),
          { _sum: { totalAmount: null } },
        ),
        safeQuery(
          () =>
            this.prisma.order.count({
              where: {
                orderStatus: OrderStatus.PLACED,
                AND: [notTestOrder],
                ...dateWhere,
              },
            }),
          0,
        ),
        safeQuery(
          () =>
            this.prisma.payment.count({
              where: {
                verificationStatus: PaymentVerificationStatus.PENDING,
                ...dateWhere,
              },
            }),
          0,
        ),
        // Deliberately NOT excluding the test buyer here — settlements are
        // seller-keyed, not buyer-keyed, and a test order's payment could
        // still generate a real payout. This is a known, accepted asymmetry
        // with totalOrders/revenueResult above, not an oversight.
        safeQuery(
          () =>
            this.prisma.sellerSettlement.count({
              where: { payoutStatus: 'PENDING', ...dateWhere },
            }),
          0,
        ),
        safeQuery(
          () =>
            this.prisma.sellerOffer.count({
              where: { deletedAt: null, ...dateWhere },
            }),
          0,
        ),
        safeQuery(
          () =>
            this.prisma.ticket.count({
              where: {
                status: { in: [TicketStatus.OPEN, TicketStatus.IN_PROGRESS] },
                ...dateWhere,
              },
            }),
          0,
        ),
        safeQuery(
          () =>
            this.prisma.user.count({
              where: { status: UserStatus.BLOCKED, ...dateWhere },
            }),
          0,
        ),
        safeQuery(
          () =>
            this.prisma.order.findMany({
              where: { ...dateWhere, AND: [notTestOrder] },
              take: 5,
              orderBy: { createdAt: 'desc' },
              select: {
                id: true,
                totalAmount: true,
                orderStatus: true,
                paymentStatus: true,
                createdAt: true,
                buyer: { select: { id: true, phone: true } },
              },
            }),
          [],
        ),
        safeQuery(
          () =>
            this.prisma.order.aggregate({
              where: {
                referralCodeId: { not: null },
                orderStatus: OrderStatus.DELIVERED,
                ...dateWhere,
              },
              _count: { id: true },
              _sum: { totalAmount: true },
            }),
          { _count: { id: 0 }, _sum: { totalAmount: null } },
        ),
        safeQuery(
          () =>
            (this.prisma as any).productRequest
              ? (this.prisma as any).productRequest.count({
                  where: { status: 'PENDING', ...dateWhere },
                })
              : Promise.resolve(0),
          0,
        ),
      ]);

      return {
        totalUsers: totalUsers ?? 0,
        totalBuyers: totalBuyers ?? 0,
        totalSellers: totalSellers ?? 0,
        blockedUsers: blockedUsers ?? 0,
        totalOrders: totalOrders ?? 0,
        totalRevenue: Number(revenueResult?._sum?.totalAmount ?? 0),
        totalProducts: totalProducts ?? 0,
        pendingOrders: pendingOrders ?? 0,
        pendingPayments: pendingPayments ?? 0,
        pendingSettlements: pendingSettlements ?? 0,
        openTickets: openTickets ?? 0,
        recentOrders: recentOrders || [],
        referralCount: Number((referralStats as any)?._count?.id ?? 0),
        referralRevenue: Number((referralStats as any)?._sum?.totalAmount ?? 0),
        pendingProductRequests: pendingProductRequests ?? 0,
      };
    } catch (error) {
      this.logger.warn(
        `Failed to fetch dashboard metrics: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      return {
        totalUsers: 0,
        totalBuyers: 0,
        totalSellers: 0,
        blockedUsers: 0,
        totalOrders: 0,
        totalRevenue: 0,
        totalProducts: 0,
        pendingOrders: 0,
        pendingPayments: 0,
        pendingSettlements: 0,
        openTickets: 0,
        recentOrders: [],
        referralCount: 0,
        referralRevenue: 0,
        pendingProductRequests: 0,
      };
    }
  }


  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // USER MANAGEMENT
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  async getAllUsers(query: QueryUsersDto) {
    try {
      const {
        role,
        status,
        search,
        dateFrom,
        dateTo,
        page = 1,
        limit = 20,
      } = query;
      const skip = (page - 1) * limit;

      const where: Prisma.UserWhereInput = {};
      if (role) where.role = role;
      if (status) where.status = status;

      if (dateFrom || dateTo) {
        where.createdAt = {};
        if (dateFrom) {
          const parsedFrom = new Date(dateFrom);
          if (!isNaN(parsedFrom.getTime())) (where.createdAt as any).gte = parsedFrom;
        }
        if (dateTo) {
          const parsedTo = new Date(dateTo);
          if (!isNaN(parsedTo.getTime())) (where.createdAt as any).lte = parsedTo;
        }
      }

      if (search) {
        where.OR = [
          { phone: { contains: search, mode: 'insensitive' } },
          { email: { contains: search, mode: 'insensitive' } },
          {
            buyerProfile: {
              legalName: { contains: search, mode: 'insensitive' },
            },
          },
          {
            sellerProfile: {
              companyName: { contains: search, mode: 'insensitive' },
            },
          },
        ];
      }

      const [data, total] = await Promise.all([
        this.prisma.user.findMany({
          where,
          select: {
            id: true,
            phone: true,
            email: true,
            role: true,
            status: true,
            createdAt: true,
            updatedAt: true,
            buyerProfile: true,
            sellerProfile: true,
          },
          orderBy: { createdAt: 'desc' },
          skip,
          take: limit,
        }),
        this.prisma.user.count({ where }),
      ]);

      return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
    } catch (error) {
      this.logger.warn(
        `Failed to fetch users: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      return { data: [], total: 0, page: query.page || 1, limit: query.limit || 20, totalPages: 0 };
    }
  }


  async getUserById(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        phone: true,
        email: true,
        role: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        buyerProfile: true,
        sellerProfile: {
          select: {
            id: true,
            companyName: true,
            gstNumber: true,
            panNumber: true,
            address: true,
            city: true,
            state: true,
            pincode: true,
            // @ts-ignore
            email: true,
            // @ts-ignore
            fssaiNumber: true,
            // @ts-ignore
            bankAccount: true,
            // @ts-ignore
            cancelCheck: true,
            drugLicenseNumber: true,
            drugLicenseUrl: true,
            drugLicenseExpiry: true,
            drugLicenseNumber2: true,
            drugLicenseUrl2: true,
            drugLicenseExpiry2: true,
            verificationStatus: true,
            updatedAt: true,
            additionalDocuments: true,
          },
        },
        _count: { select: { orders: true, reviews: true, tickets: true } },
      },
    });

    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async getPendingUsers() {
    return this.prisma.user.findMany({
      where: { status: UserStatus.PENDING },
      select: {
        id: true,
        phone: true,
        email: true,
        role: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        buyerProfile: true,
        sellerProfile: true,
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async approveUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { sellerProfile: true },
    });

    if (!user) throw new NotFoundException('User not found');
    if (user.status === UserStatus.APPROVED) {
      throw new BadRequestException('User is already approved');
    }

    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: { status: UserStatus.APPROVED },
      select: {
        id: true,
        phone: true,
        email: true,
        role: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        buyerProfile: true,
        sellerProfile: true,
      },
    });

    if (user.sellerProfile) {
      await this.prisma.sellerProfile.update({
        where: { userId },
        data: { verificationStatus: 'VERIFIED' },
      });
    }

    // Also approve buyer profile â€” set VERIFIED + default PREPAID tier so buyer can place orders
    const buyerProfile = await this.prisma.buyerProfile.findUnique({
      where: { userId },
    });
    if (buyerProfile) {
      await this.prisma.buyerProfile.update({
        where: { userId },
        data: {
          verificationStatus: 'VERIFIED',
          creditTier: buyerProfile.creditTier ?? 'PREPAID', // preserve existing tier, or default to PREPAID
        },
      });
    }

    this.logger.log(`User ${userId} approved by admin`);
    await this.notificationsService.notifyUserVerified(userId, user.role);

    if (user.sellerProfile) {
      await this.emailSellerApproved(user.sellerProfile, userId, updatedUser.email);
    }

    return updatedUser;
  }

  /**
   * Best-effort — approval has already succeeded and been persisted by the
   * time this runs, so a mail failure here must never surface to the caller.
   */
  private async emailSellerApproved(
    sellerProfile: { email: string | null; companyName: string },
    userId: string,
    loginEmail: string | null,
  ): Promise<void> {
    const to = sellerProfile.email?.trim() || loginEmail?.trim();
    if (!to) return;

    const result = await this.mailService.sendMail({
      to,
      subject: 'Your Yukizi seller account has been approved!',
      text: `Hello ${sellerProfile.companyName},\n\nYour Yukizi seller account has been approved. You can now log in to your seller dashboard and start listing products.\n\nYukizi`,
      html: `<p>Hello ${this.escape(sellerProfile.companyName)},</p><p>Your Yukizi seller account has been approved. You can now log in to your seller dashboard and start listing products.</p><p>Yukizi</p>`,
    });
    if (!result.sent) {
      this.logger.warn(
        `Could not email seller ${userId} about their approval (retryable=${result.retryable})`,
      );
    }
  }

  private escape(value: string): string {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async rejectUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { sellerProfile: true },
    });

    if (!user) throw new NotFoundException('User not found');
    if (user.status === UserStatus.REJECTED) {
      throw new BadRequestException('User is already rejected');
    }

    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: { status: UserStatus.REJECTED },
      select: {
        id: true,
        phone: true,
        email: true,
        role: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        buyerProfile: true,
        sellerProfile: true,
      },
    });

    if (user.sellerProfile) {
      await this.prisma.sellerProfile.update({
        where: { userId },
        data: { verificationStatus: 'REJECTED' },
      });
    }

    // Also reject buyer profile
    const buyerProfile = await this.prisma.buyerProfile.findUnique({
      where: { userId },
    });
    if (buyerProfile) {
      await this.prisma.buyerProfile.update({
        where: { userId },
        data: { verificationStatus: 'REJECTED', creditTier: null },
      });
    }

    this.logger.log(`User ${userId} rejected by admin`);
    await this.notificationsService.notifyUserRejected(userId, user.role);
    return updatedUser;
  }

  async blockUser(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    if (user.status === UserStatus.BLOCKED) {
      throw new BadRequestException('User is already blocked');
    }

    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: { status: UserStatus.BLOCKED },
      select: {
        id: true,
        phone: true,
        email: true,
        role: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        buyerProfile: true,
        sellerProfile: true,
      },
    });

    this.logger.log(`User ${userId} blocked by admin`);
    return updatedUser;
  }

  async unblockUser(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    if (user.status !== UserStatus.BLOCKED) {
      throw new BadRequestException('User is not blocked');
    }

    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: { status: UserStatus.APPROVED },
      select: {
        id: true,
        phone: true,
        email: true,
        role: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        buyerProfile: true,
        sellerProfile: true,
      },
    });

    this.logger.log(`User ${userId} unblocked by admin`);
    return updatedUser;
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // PRODUCT MANAGEMENT
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  async getAllProducts(query: AdminQueryProductsDto) {
    try {
      const {
        sellerId,
        categoryId,
        subCategoryId,
        search,
        isActive,
        approvalStatus,
        page = 1,
        limit = 20,
      } = query;
      const skip = (page - 1) * limit;

      const where: Prisma.SellerOfferWhereInput = { deletedAt: null };
      if (sellerId) where.sellerId = sellerId;
      if (categoryId) where.categoryId = categoryId;
      if (subCategoryId) where.subCategoryId = subCategoryId;
      if (isActive === 'true') where.isActive = true;
      if (isActive === 'false') where.isActive = false;
      if (
        approvalStatus &&
        ['PENDING', 'APPROVED', 'REJECTED'].includes(approvalStatus.toUpperCase())
      ) {
        where.approvalStatus =
          approvalStatus.toUpperCase() as ProductApprovalStatus;
      }

      if (search) {
        where.OR = [
          { name: { contains: search, mode: 'insensitive' } },
          { manufacturer: { contains: search, mode: 'insensitive' } },
        ];
      }

      const [data, total] = await Promise.all([
        this.prisma.sellerOffer.findMany({
          where,
          select: {
            id: true,
            name: true,
            manufacturer: true,
            mrp: true,
            finalCustomerPayable: true,
            gstPercent: true,
            isActive: true,
            approvalStatus: true,
            rejectionReason: true,
            createdAt: true,
            updatedAt: true,
            catalogProductId: true,
            variant: {
              select: {
                catalogProduct: {
                  select: {
                    id: true,
                    _count: { select: { productVariants: true } },
                  },
                },
              },
            },
            seller: { select: { id: true, companyName: true, userId: true } },
            category: { select: { id: true, name: true } },
            subCategory: { select: { id: true, name: true } },
            batches: {
              select: {
                id: true,
                batchNumber: true,
                stock: true,
                expiryDate: true,
              },
              orderBy: { expiryDate: 'asc' },
            },
            inventoryAlerts: {
              select: {
                id: true,
                alertType: true,
                message: true,
                createdAt: true,
              },
              take: 5,
              orderBy: { createdAt: 'desc' },
            },
            _count: { select: { reviews: true, orderItems: true } },
          },
          orderBy: { createdAt: 'desc' },
          skip,
          take: limit,
        }),
        this.prisma.sellerOffer.count({ where }),
      ]);

      const dataWithSellers = await this.attachOtherSellers(data);

      return { data: dataWithSellers, total, page, limit, totalPages: Math.ceil(total / limit) };
    } catch (error) {
      this.logger.warn(
        `Failed to fetch products: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      return { data: [], total: 0, page: query.page || 1, limit: query.limit || 20, totalPages: 0 };
    }
  }

  /**
   * For each seller-offer row in an admin product listing, resolve how many
   * OTHER sellers carry the same underlying catalog product, and their names.
   * A listing reaches its catalog product via one of two independent, mutually
   * exclusive paths - the same distinction adminUpdateProduct() below already
   * has to account for: either a direct catalogProductId (simple products),
   * or variant.catalogProduct.id (variant products, e.g. an English/Malayalam
   * edition pair). One batched query covers both paths across the whole page
   * rather than a query per row.
   */
  private async attachOtherSellers<
    T extends {
      id: string;
      catalogProductId: string | null;
      variant: { catalogProduct: { id: string } | null } | null;
    },
  >(offers: T[]): Promise<(T & { sellerCount: number; sellers: { id: string; companyName: string }[] })[]> {
    const resolvedCatalogProductId = (offer: T): string | null =>
      offer.catalogProductId ?? offer.variant?.catalogProduct?.id ?? null;

    const catalogProductIds = Array.from(
      new Set(offers.map(resolvedCatalogProductId).filter((id): id is string => id !== null)),
    );

    if (catalogProductIds.length === 0) {
      return offers.map((offer) => ({ ...offer, sellerCount: 1, sellers: [] }));
    }

    const siblingOffers = await this.prisma.sellerOffer.findMany({
      where: {
        deletedAt: null,
        OR: [
          { catalogProductId: { in: catalogProductIds } },
          { variant: { catalogProductId: { in: catalogProductIds } } },
        ],
      },
      select: {
        catalogProductId: true,
        variant: { select: { catalogProductId: true } },
        seller: { select: { id: true, companyName: true } },
      },
    });

    const sellersByCatalogProductId = new Map<string, Map<string, string>>();
    for (const sibling of siblingOffers) {
      const cpId = sibling.catalogProductId ?? sibling.variant?.catalogProductId ?? null;
      if (!cpId) continue;
      const sellersMap = sellersByCatalogProductId.get(cpId) ?? new Map<string, string>();
      sellersMap.set(sibling.seller.id, sibling.seller.companyName);
      sellersByCatalogProductId.set(cpId, sellersMap);
    }

    return offers.map((offer) => {
      const cpId = resolvedCatalogProductId(offer);
      const sellersMap = cpId ? sellersByCatalogProductId.get(cpId) : undefined;
      if (!sellersMap) {
        return { ...offer, sellerCount: 1, sellers: [] };
      }
      return {
        ...offer,
        sellerCount: sellersMap.size,
        sellers: Array.from(sellersMap, ([id, companyName]) => ({ id, companyName })),
      };
    });
  }

  /**
   * Admin edit of a product's master (catalog) fields. The admin UI works
   * with seller-offer ids, so the offer is resolved to its CatalogProduct
   * first. A slug change also swaps the 301 redirects (see product-slug.ts)
   * so the old public URL keeps working.
   */
  async adminUpdateProduct(sellerOfferId: string, dto: AdminUpdateProductDto) {
    const offer = await this.prisma.sellerOffer.findUnique({
      where: { id: sellerOfferId },
      select: {
        id: true,
        // A listing's catalog product is reached either directly
        // (catalogProductId, the common case) or via a variant — same
        // fallback order as products.service.ts::findOne. The variant-only
        // lookup this used to have threw "no catalog product to edit" for
        // every direct-linked listing, which is most of them.
        catalogProduct: { select: { id: true, slug: true } },
        variant: { select: { catalogProduct: { select: { id: true, slug: true } } } },
      },
    });
    if (!offer) throw new NotFoundException('Product not found');
    const master = offer.catalogProduct ?? offer.variant?.catalogProduct;
    if (!master) {
      throw new NotFoundException('This listing has no catalog product to edit');
    }

    const { slug, slugRedirect, ...rest } = dto;
    const fields = Object.fromEntries(
      Object.entries(rest).filter(([, v]) => v !== undefined),
    );
    if (Object.keys(fields).length) {
      await this.prisma.catalogProduct.update({ where: { id: master.id }, data: fields });
    }
    if (slug !== undefined) {
      await applySlugChange(this.prisma as unknown as SlugPrisma, master, slug, {
        createRedirect: slugRedirect,
      });
    }
    return this.getProductById(sellerOfferId);
  }

  async getProductById(sellerOfferId: string) {
    const product = await this.prisma.sellerOffer.findUnique({
      where: { id: sellerOfferId },
      include: {
        seller: {
          select: {
            id: true,
            companyName: true,
            userId: true,
            city: true,
            state: true,
          },
        },
        category: { select: { id: true, name: true } },
        subCategory: { select: { id: true, name: true } },
        // Master (catalog) product — the slug lives here, and it's what the
        // admin edit + URL-slug features operate on.
        variant: {
          select: {
            id: true,
            catalogProduct: { select: { id: true, name: true, slug: true } },
          },
        },
        batches: { orderBy: { expiryDate: 'asc' } },

        inventoryAlerts: { orderBy: { createdAt: 'desc' }, take: 10 },
        _count: {
          select: { reviews: true, orderItems: true, cartItems: true },
        },
      },
    });

    if (!product) throw new NotFoundException('Product not found');
    return product;
  }

  async disableProduct(sellerOfferId: string) {
    const product = await this.prisma.sellerOffer.findUnique({
      where: { id: sellerOfferId },
    });
    if (!product) throw new NotFoundException('Product not found');
    if (!product.isActive)
      throw new BadRequestException('Product is already disabled');

    const updated = await this.prisma.sellerOffer.update({
      where: { id: sellerOfferId },
      data: { isActive: false },
      select: { id: true, name: true, isActive: true, updatedAt: true },
    });

    this.logger.log(`Product ${sellerOfferId} disabled by admin`);
    return updated;
  }

  async enableProduct(sellerOfferId: string) {
    const product = await this.prisma.sellerOffer.findUnique({
      where: { id: sellerOfferId },
    });
    if (!product) throw new NotFoundException('Product not found');
    if (product.isActive)
      throw new BadRequestException('Product is already active');

    const updated = await this.prisma.sellerOffer.update({
      where: { id: sellerOfferId },
      data: { isActive: true },
      select: { id: true, name: true, isActive: true, updatedAt: true },
    });

    this.logger.log(`Product ${sellerOfferId} enabled by admin`);
    return updated;
  }

  async softDeleteProduct(sellerOfferId: string) {
    const product = await this.prisma.sellerOffer.findUnique({
      where: { id: sellerOfferId },
    });
    if (!product) throw new NotFoundException('Product not found');
    if (product.deletedAt)
      throw new BadRequestException('Product is already deleted');

    const updated = await this.prisma.sellerOffer.update({
      where: { id: sellerOfferId },
      data: { deletedAt: new Date(), isActive: false },
      select: { id: true, name: true, isActive: true, deletedAt: true },
    });

    this.logger.log(`Product ${sellerOfferId} soft-deleted by admin`);
    return updated;
  }

  async approveProduct(sellerOfferId: string) {
    const product = await this.prisma.sellerOffer.findUnique({
      where: { id: sellerOfferId },
    });
    if (!product) throw new NotFoundException('Product not found');
    if (product.approvalStatus === ProductApprovalStatus.APPROVED) {
      throw new BadRequestException('Product is already approved');
    }

    let variantId = product.variantId;
    if (!variantId) {
      let existingMaster = await this.prisma.catalogProduct.findFirst({
        where: {
          name: { equals: product.name, mode: 'insensitive' },
          manufacturer: { equals: product.manufacturer, mode: 'insensitive' },
          deletedAt: null,
        },
      });

      if (!existingMaster) {
        const baseSlug = product.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');
        const uniqueSlug = `${baseSlug}-${Math.random().toString(36).substring(2, 8)}`;

        existingMaster = await this.prisma.catalogProduct.create({
          data: {
            name: product.name,
            slug: uniqueSlug,
            manufacturer: product.manufacturer,
            sku: product.sku,
            serialNo: product.serialNo,
            specifications: product.specifications,
            description: product.description,
            mrp: product.mrp,
            gstPercent: product.gstPercent,
            isTaxIncluded: product.isTaxIncluded,
            shippingCharges: product.shippingCharges,
            finalShippingPrice: product.finalShippingPrice,
            categoryId: product.categoryId,
            subCategoryId: product.subCategoryId,
          },
        });
      }

      let variant = await this.prisma.productVariant.findFirst({
        where: { catalogProductId: existingMaster.id },
      });

      if (!variant) {
        variant = await this.prisma.productVariant.create({
          data: {
            catalogProductId: existingMaster.id,
            name: 'Default',
            sku: product.sku,
            serialNo: product.serialNo,
            options: {},
          },
        });
      }
      
      variantId = variant.id;
    }

    const updated = await this.prisma.sellerOffer.update({
      where: { id: sellerOfferId },
      data: {
        approvalStatus: ProductApprovalStatus.APPROVED,
        isActive: true,
        rejectionReason: null,
        variantId,
      },
      select: {
        id: true,
        name: true,
        isActive: true,
        approvalStatus: true,
        updatedAt: true,
        seller: { select: { id: true, companyName: true } },
      },
    });

    this.logger.log(`Product ${sellerOfferId} approved by admin`);
    return updated;
  }

  async rejectProduct(sellerOfferId: string, reason?: string) {
    const product = await this.prisma.sellerOffer.findUnique({
      where: { id: sellerOfferId },
    });
    if (!product) throw new NotFoundException('Product not found');
    if (product.approvalStatus === ProductApprovalStatus.REJECTED) {
      throw new BadRequestException('Product is already rejected');
    }

    const updated = await this.prisma.sellerOffer.update({
      where: { id: sellerOfferId },
      data: {
        approvalStatus: ProductApprovalStatus.REJECTED,
        isActive: false,
        rejectionReason: reason || null,
      },
      select: {
        id: true,
        name: true,
        isActive: true,
        approvalStatus: true,
        rejectionReason: true,
        updatedAt: true,
        seller: { select: { id: true, companyName: true } },
      },
    });

    this.logger.log(
      `Product ${sellerOfferId} rejected by admin${reason ? `: ${reason}` : ''}`,
    );
    return updated;
  }

  async adminCreateProductForSeller(
    adminUserId: string,
    dto: AdminCreateProductDto,
  ) {
    const { sellerId, ...productDto } = dto;
    return this.productsService.create(sellerId, productDto, adminUserId);
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // ORDER MANAGEMENT
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  async getAllOrders(query: AdminQueryOrdersDto) {
    const {
      status,
      search,
      sellerId,
      buyerId,
      dateFrom,
      dateTo,
      page = 1,
      limit = 20,
    } = query;
    const skip = (page - 1) * limit;

    const where: Prisma.OrderWhereInput = {};
    if (status) where.orderStatus = status;
    if (buyerId) where.buyerId = buyerId;
    if (sellerId) where.items = { some: { sellerId } };

    if (search) {
      where.OR = [
        { id: { contains: search, mode: 'insensitive' } },
        { buyerId: { contains: search, mode: 'insensitive' } },
        { buyer: { phone: { contains: search, mode: 'insensitive' } } },
        { address: { name: { contains: search, mode: 'insensitive' } } },
        {
          items: {
            some: { sellerId: { contains: search, mode: 'insensitive' } },
          },
        },
        {
          items: {
            some: {
              seller: {
                companyName: { contains: search, mode: 'insensitive' },
              },
            },
          },
        },
      ];
    }

    if (dateFrom || dateTo) {
      where.createdAt = {};
      if (dateFrom) {
        const parsedFrom = new Date(dateFrom);
        if (!isNaN(parsedFrom.getTime())) (where.createdAt as any).gte = parsedFrom;
      }
      if (dateTo) {
        const parsedTo = new Date(dateTo);
        if (!isNaN(parsedTo.getTime())) (where.createdAt as any).lte = parsedTo;
      }
    }

    const testPhones = this.getTestBuyerPhones();
    const overrides = await this.getOrderOverrides();

    if (query.includeTestOrders !== 'true') {
      // Hidden when the phone rule OR an explicit test override says test —
      // unless the order is explicitly marked real, which beats both.
      // Composed into AND so it cannot collide with the search filter's OR.
      const notTest = await this.notTestOrderWhere();
      where.AND = [
        ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
        notTest,
      ];
    }

    const [data, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        select: {
          id: true,
          totalAmount: true,
          orderStatus: true,
          paymentStatus: true,
          createdAt: true,
          updatedAt: true,
          buyer: {
            select: {
              id: true,
              phone: true,
              email: true,
              buyerProfile: { select: { legalName: true } },
            },
          },
          items: {
            select: {
              id: true,
              quantity: true,
              unitPrice: true,
              totalPrice: true,
              sellerOffer: { select: { id: true, name: true } },
              seller: { select: { id: true, companyName: true } },
              settlement: { select: { id: true, payoutStatus: true } },
            },
          },
          address: true,
          payments: {
            select: { proofUrl: true },
            take: 1,
            orderBy: { createdAt: 'desc' },
          },
          _count: { select: { payments: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.order.count({ where }),
    ]);

    // Tell the caller WHY each row is where it is, so the admin screen can
    // offer the right action ("mark as test" / "mark as real") instead of
    // making someone guess which rule caught it.
    const rows = data.map((order) => {
      const { isTest, classification } = this.classify(order, testPhones, overrides);
      return { ...order, isTestOrder: isTest, classification };
    });

    return { data: rows, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  /**
   * Pin one order to the real or the test side, or hand it back to the phone
   * rule with 'auto'. An id appears in at most one list, so the two can never
   * disagree about the same order.
   */
  async setOrderClassification(orderId: string, classification: OrderClassification) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true },
    });
    if (!order) throw new NotFoundException('Order not found');

    const { real, test } = await this.getOrderOverrides();
    const nextReal = new Set(real);
    const nextTest = new Set(test);
    nextReal.delete(orderId);
    nextTest.delete(orderId);
    if (classification === 'real') nextReal.add(orderId);
    if (classification === 'test') nextTest.add(orderId);

    const write = (key: string, value: string) =>
      this.prisma.systemSetting.upsert({
        where: { key },
        update: { value },
        create: { key, value },
      });

    await this.prisma.$transaction([
      write(REAL_ORDER_IDS_KEY, Array.from(nextReal).join(',')),
      write(TEST_ORDER_IDS_KEY, Array.from(nextTest).join(',')),
    ]);

    this.logger.log(`Order ${orderId} classified as ${classification}`);
    return { orderId, classification };
  }

  async getOrderById(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        buyer: {
          select: {
            id: true,
            phone: true,
            email: true,
            buyerProfile: {
              select: {
                legalName: true,
                gstNumber: true,
                panNumber: true,
                drugLicenseNumber: true,
                drugLicenseNumber2: true,
                drugLicenseExpiry: true,
                drugLicenseExpiry2: true,
                address: true,
                city: true,
                state: true,
                pincode: true,
                drugLicenseUrl: true,
                drugLicenseUrl2: true,
                cancelCheck: true,
                document: true,
              },
            },
          },
        },
        items: {
          include: {
            sellerOffer: {
              select: {
                id: true,
                name: true,
                manufacturer: true,
                mrp: true,
                gstPercent: true,
                shippingCharges: true,
                finalShippingPrice: true,
                discountType: true,
                discountMeta: true,
                isTaxIncluded: true,
                finalCustomerPayable: true,
                catalogProduct: {
                  select: {
                    commissionPercent: true,
                    commissionGstPercent: true,
                    images: {
                      orderBy: [{ order: 'asc' }, { id: 'asc' }],
                      select: { url: true },
                    },
                    category: {
                      select: {
                        commissionPercent: true,
                        commissionGstPercent: true,
                      },
                    },
                    subCategory: {
                      select: {
                        commissionPercent: true,
                        commissionGstPercent: true,
                      },
                    },
                  },
                },
                variant: {
                  select: {
                    catalogProduct: {
                      select: {
                        commissionPercent: true,
                        commissionGstPercent: true,
                        images: {
                          orderBy: [{ order: 'asc' }, { id: 'asc' }],
                          select: { url: true },
                        },
                        category: {
                          select: {
                            commissionPercent: true,
                            commissionGstPercent: true,
                          },
                        },
                        subCategory: {
                          select: {
                            commissionPercent: true,
                            commissionGstPercent: true,
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            seller: { select: { id: true, companyName: true } },
            settlement: true,
          },
        },
        address: true,
        payments: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            amount: true,
            method: true,
            referenceNumber: true,
            proofUrl: true,
            verificationStatus: true,
            createdAt: true,
          },
        },
      },
    });

    if (!order) throw new NotFoundException('Order not found');

    const items = order.items.map((item: any) => {
      let estimatedPayout: any = null;
      if (item.settlement) {
        const comm = Number(item.settlement.commission || 0);
        const commGst = Number(item.settlement.commissionGst || 0);
        const ship = Number(item.sellerOffer?.finalShippingPrice ?? item.sellerOffer?.shippingCharges ?? 0);
        const net = Number(item.settlement.netPayout || item.settlement.amount || 0);
        const gross = Number(item.settlement.grossAmount || item.totalPrice || 0);
        const catalogProd = item.sellerOffer?.catalogProduct ?? item.sellerOffer?.variant?.catalogProduct;
        const commissionPercent = Number(
          catalogProd?.commissionPercent ??
          catalogProd?.subCategory?.commissionPercent ??
          catalogProd?.category?.commissionPercent ??
          item.sellerOffer?.commissionPercent ??
          0
        );
        const commissionGstPercent = Number(
          catalogProd?.commissionGstPercent ??
          catalogProd?.subCategory?.commissionGstPercent ??
          catalogProd?.category?.commissionGstPercent ??
          item.sellerOffer?.commissionGstPercent ??
          18
        );
        estimatedPayout = {
          grossAmount: gross,
          commission: comm,
          commissionGst: commGst,
          finalShippingPrice: ship,
          totalDeductions: comm + commGst + ship,
          netPayout: net,
          commissionPercent,
          commissionGstPercent,
          status: item.settlement.payoutStatus,
          isLedgered: true,
        };
      } else {
        const input = buildPayoutInputFromOrderItem(item);
        const breakdown = calculateSellerPayout(input);
        estimatedPayout = {
          grossAmount: breakdown.grossAmount.toNumber(),
          commission: breakdown.commission.toNumber(),
          commissionGst: breakdown.commissionGst.toNumber(),
          finalShippingPrice: breakdown.finalShippingPrice.toNumber(),
          totalDeductions: breakdown.totalDeductions.toNumber(),
          netPayout: breakdown.netPayout.toNumber(),
          commissionPercent: input.commissionPercent,
          commissionGstPercent: input.commissionGstPercent,
          status: breakdown.status,
          isLedgered: false,
        };
      }
      return {
        ...item,
        estimatedPayout,
      };
    });

    return {
      ...order,
      items,
    };
  }

  async adminUpdateOrderStatus(
    orderId: string,
    dto: AdminUpdateOrderStatusDto,
  ) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        address: true,
        buyer: {
          select: {
            email: true,
            phone: true,
            buyerProfile: { select: { legalName: true } },
          },
        },
        items: { include: { sellerOffer: true } },
      },
    });
    if (!order) throw new NotFoundException('Order not found');

    const updateData: Prisma.OrderUpdateInput = { orderStatus: dto.status };

    // Push to Shiprocket if the admin advances the order to READY_TO_SHIP —
    // this is the path admin actually uses (the seller-facing status buttons
    // are hidden), so this must carry the same Shiprocket push the seller
    // path has, or nothing ever creates the shipment. See OrdersService.
    if (dto.status === OrderStatus.READY_TO_SHIP) {
      Object.assign(
        updateData,
        await this.ordersService.pushOrderToShiprocketIfNeeded(order),
      );
    }

    const updated = await this.prisma.order.update({
      where: { id: orderId },
      data: updateData,
      include: {
        buyer: {
          select: {
            phone: true,
            buyerProfile: { select: { legalName: true } },
          },
        },
        items: {
          include: {
            sellerOffer: { select: { name: true } },
            seller: { select: { companyName: true } },
          },
        },
      },
    });

    await this.ordersService.notifyBuyerOfStatusChange(
      { id: order.id, buyerId: order.buyerId, buyer: order.buyer },
      dto.status,
    );

    // Create settlements if status is DELIVERED and payment is successful
    if (
      updated.orderStatus === OrderStatus.DELIVERED &&
      updated.paymentStatus === PaymentStatus.SUCCESS
    ) {
      for (const item of updated.items) {
        const existing = await this.prisma.sellerSettlement.findUnique({
          where: { orderItemId: item.id },
        });
        if (!existing) {
          const commission = +(item.totalPrice.toNumber() * 0.05).toFixed(2);
          await this.prisma.sellerSettlement.create({
            data: {
              sellerId: item.sellerId,
              orderItemId: item.id,
              amount: +(item.totalPrice.toNumber() - commission).toFixed(2),
              commission,
              grossAmount: item.totalPrice,
              commissionGst: 0,
              fixedFee: 0,
              fixedFeeGst: 0,
              withholdingTax: 0,
              netPayout: +(item.totalPrice.toNumber() - commission).toFixed(2),
              payoutStatus: 'PENDING',
            },
          });
        }
      }
    }

    this.logger.log(
      `Order ${orderId} status overridden to ${dto.status} by admin`,
    );
    return updated;
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // PAYMENT MANAGEMENT
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  async getAllPayments(query: AdminQueryPaymentsDto) {
    const { verificationStatus, orderId, page = 1, limit = 20 } = query;
    const skip = (page - 1) * limit;

    const where: Prisma.PaymentWhereInput = {};
    if (verificationStatus) where.verificationStatus = verificationStatus;
    if (orderId) where.orderId = orderId;

    const [data, total] = await Promise.all([
      this.prisma.payment.findMany({
        where,
        select: {
          id: true,
          orderId: true,
          amount: true,
          method: true,
          referenceNumber: true,
          proofUrl: true,
          verificationStatus: true,
          createdAt: true,
          updatedAt: true,
          order: {
            select: {
              id: true,
              totalAmount: true,
              orderStatus: true,
              buyer: { select: { id: true, phone: true } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.payment.count({ where }),
    ]);

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async adminConfirmPayment(paymentId: string) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: {
        order: {
          include: {
            items: { select: { id: true, sellerId: true, totalPrice: true } },
          },
        },
      },
    });

    if (!payment) throw new NotFoundException('Payment not found');
    if (payment.verificationStatus === PaymentVerificationStatus.CONFIRMED) {
      throw new BadRequestException('Payment is already confirmed');
    }
    if (payment.verificationStatus === PaymentVerificationStatus.REJECTED) {
      throw new BadRequestException('Cannot confirm a rejected payment');
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const confirmed = await tx.payment.update({
        where: { id: paymentId },
        data: { verificationStatus: PaymentVerificationStatus.CONFIRMED },
      });

      // Recalculate order payment status
      const confirmedPayments = await tx.payment.findMany({
        where: {
          orderId: payment.orderId,
          verificationStatus: PaymentVerificationStatus.CONFIRMED,
        },
      });

      const totalPaid = confirmedPayments.reduce((sum, p) => sum + p.amount.toNumber(), 0);
      const newStatus =
        totalPaid >= payment.order.totalAmount.toNumber()
          ? PaymentStatus.SUCCESS
          : totalPaid > 0
            ? PaymentStatus.PARTIAL
            : PaymentStatus.PENDING;

      // Payment success no longer advances orderStatus — the "Paid"
      // stepper stage was removed from the pipeline (2026-08-23 spec).
      await tx.order.update({
        where: { id: payment.orderId },
        data: { paymentStatus: newStatus },
      });

      // If fully paid AND delivered â†’ create seller settlements
      if (
        newStatus === PaymentStatus.SUCCESS &&
        payment.order.orderStatus === OrderStatus.DELIVERED
      ) {
        for (const item of payment.order.items) {
          const existing = await tx.sellerSettlement.findUnique({
            where: { orderItemId: item.id },
          });
          if (!existing) {
            const commission = +(item.totalPrice.toNumber() * 0.05).toFixed(2);
            await tx.sellerSettlement.create({
              data: {
                sellerId: item.sellerId,
                orderItemId: item.id,
                amount: +(item.totalPrice.toNumber() - commission).toFixed(2),
                commission,
                grossAmount: item.totalPrice,
                commissionGst: 0,
                fixedFee: 0,
                fixedFeeGst: 0,
                withholdingTax: 0,
                netPayout: +(item.totalPrice.toNumber() - commission).toFixed(2),
                payoutStatus: 'PENDING',
              },
            });
          }
        }
      }

      return { confirmed, totalPaid, newStatus };
    });

    this.logger.log(`Payment ${paymentId} confirmed by admin`);
    return {
      payment: result.confirmed,
      orderPaymentStatus: result.newStatus,
      totalPaid: result.totalPaid,
      totalAmount: payment.order.totalAmount,
    };
  }

  async adminRejectPayment(paymentId: string) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
    });
    if (!payment) throw new NotFoundException('Payment not found');
    if (payment.verificationStatus === PaymentVerificationStatus.REJECTED) {
      throw new BadRequestException('Payment is already rejected');
    }
    if (payment.verificationStatus === PaymentVerificationStatus.CONFIRMED) {
      throw new BadRequestException('Cannot reject a confirmed payment');
    }

    const rejected = await this.prisma.payment.update({
      where: { id: paymentId },
      data: { verificationStatus: PaymentVerificationStatus.REJECTED },
    });

    this.logger.log(`Payment ${paymentId} rejected by admin`);
    return rejected;
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // MARKETING MANAGEMENT
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  async getMarketingProducts(slot?: any) {
    return this.prisma.marketingProduct.findMany({
      where: slot ? { slot } : {},
      include: {
        sellerOffer: {
          include: {
            seller: { select: { companyName: true } },
          },
        },
      },
      orderBy: { priority: 'desc' },
    });
  }

  async addMarketingProduct(dto: any) {
    const existing = await this.prisma.marketingProduct.findFirst({
      where: { catalogProductId: dto.sellerOfferId, slot: dto.slot },
    });

    if (existing) {
      return this.prisma.marketingProduct.update({
        where: { id: existing.id },
        data: { priority: dto.priority ?? 0 },
      });
    }

    return this.prisma.marketingProduct.create({
      data: {
        catalogProductId: dto.sellerOfferId,
        slot: dto.slot,
        priority: dto.priority ?? 0,
      },
    });
  }

  async removeMarketingProduct(id: string) {
    return this.prisma.marketingProduct.delete({
      where: { id },
    });
  }
  // Shared by getAllSettlements (paginated list) and getSettlementsSummary
  // (unpaginated totals) so both agree on exactly which records a given
  // status/seller/date filter matches.
  private buildSettlementFilters(query: {
    status?: string;
    sellerId?: string;
    orderItemId?: string;
    dateFrom?: string;
    dateTo?: string;
  }) {
    const { status, sellerId, orderItemId, dateFrom, dateTo } = query;

    const where: Prisma.SellerSettlementWhereInput = {};
    if (status && status !== 'PROJECTED') where.payoutStatus = status;
    if (sellerId) where.sellerId = sellerId;
    if (orderItemId) where.orderItemId = orderItemId.length === 36 ? orderItemId : ({ contains: orderItemId } as any);

    if (dateFrom || dateTo) {
      where.createdAt = {};
      if (dateFrom) {
        const parsedFrom = new Date(dateFrom);
        if (!isNaN(parsedFrom.getTime())) (where.createdAt as any).gte = parsedFrom;
      }
      if (dateTo) {
        const parsedTo = new Date(dateTo);
        if (!isNaN(parsedTo.getTime())) (where.createdAt as any).lte = parsedTo;
      }
    }

    const pendingWhere: import('@prisma/client').Prisma.OrderItemWhereInput = {
      order: { orderStatus: { not: 'CANCELLED' } },
      settlement: null,
    };
    if (sellerId) pendingWhere.sellerId = sellerId;
    if (orderItemId) pendingWhere.id = orderItemId.length === 36 ? orderItemId : ({ contains: orderItemId } as any);
    if (dateFrom || dateTo) {
      pendingWhere.createdAt = {};
      if (dateFrom) {
        const parsedFrom = new Date(dateFrom);
        if (!isNaN(parsedFrom.getTime())) (pendingWhere.createdAt as any).gte = parsedFrom;
      }
      if (dateTo) {
        const parsedTo = new Date(dateTo);
        if (!isNaN(parsedTo.getTime())) (pendingWhere.createdAt as any).lte = parsedTo;
      }
    }

    return { where, pendingWhere };
  }

  async getAllSettlements(query: AdminQuerySettlementsDto) {
    try {
      const {
        status,
        page = 1,
        limit = 20,
      } = query;
      const skip = (page - 1) * limit;
      const { where, pendingWhere } = this.buildSettlementFilters(query);

      let projectedSettlements: any[] = [];
      let pendingCount = 0;
      
      // Only fetch pending items if status is not explicitly demanding a settled status
      if (!status || status === 'PROJECTED') {
        pendingCount = (this.prisma as any).orderItem ? await this.prisma.orderItem.count({ where: pendingWhere }) : 0;
      }

      const settledCount = (!status || status !== 'PROJECTED') && (this.prisma as any).sellerSettlement ? await this.prisma.sellerSettlement.count({ where }) : 0;
      const total = pendingCount + settledCount;

      let takePending = 0;
      let skipPending = 0;
      let takeSettled = 0;
      let skipSettled = 0;

      if (status === 'PROJECTED') {
        // Admin explicitly wants the forecast-only view.
        skipPending = skip;
        takePending = limit;
      } else if (status) {
        // Admin explicitly filtered to a real settlement status
        // (PENDING/PROCESSED/PAID/etc) — PROJECTED rows never match a real
        // payoutStatus, so this is settled-only.
        skipSettled = skip;
        takeSettled = limit;
      } else {
        // Default "ALL" view: real settlement records (actual money
        // owed/paid) take priority over PROJECTED (forecast) entries, so a
        // page is filled with settled records first and only falls back to
        // PROJECTED items to fill remaining space.
        if (skip < settledCount) {
          skipSettled = skip;
          takeSettled = Math.min(limit, settledCount - skip);
          if (takeSettled < limit) {
            takePending = limit - takeSettled;
            skipPending = 0;
          }
        } else {
          skipPending = skip - settledCount;
          takePending = limit;
        }
      }

      if (takePending > 0 && (this.prisma as any).orderItem) {
        const pendingItems = await this.prisma.orderItem.findMany({
          where: pendingWhere,
          orderBy: { createdAt: 'desc' },
          include: {
            sellerOffer: { include: { catalogProduct: true } },
            seller: { select: { id: true, companyName: true, userId: true } },
          },
          skip: skipPending,
          take: takePending,
        });

        projectedSettlements = pendingItems.map(item => {
          const input = buildPayoutInputFromOrderItem(item);
          const breakdown = calculateSellerPayout(input);

          return {
            id: `projected-${item.id}`,
            sellerId: item.sellerId,
            orderItemId: item.id,
            amount: breakdown.netPayout.toString(),
            grossAmount: breakdown.grossAmount.toString(),
            commission: breakdown.commission.toString(),
            commissionGst: breakdown.commissionGst.toString(),
            fixedFee: '0',
            fixedFeeGst: '0',
            withholdingTax: '0',
            netPayout: breakdown.netPayout.toString(),
            payoutStatus: 'PROJECTED',
            createdAt: item.createdAt,
            updatedAt: item.createdAt,
            payoutReference: null,
            payoutDate: null,
            seller: item.seller,
            orderItem: {
              id: item.id,
              orderId: item.orderId,
              totalPrice: item.totalPrice,
              sellerOffer: {
                id: item.sellerOffer?.id,
                name: item.sellerOffer?.name,
              },
            },
          };
        });
      }

      let settledData: any[] = [];
      if (takeSettled > 0 && (this.prisma as any).sellerSettlement) {
        settledData = await this.prisma.sellerSettlement.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          include: {
            seller: { select: { id: true, companyName: true, userId: true } },
            orderItem: {
              select: {
                id: true,
                orderId: true,
                totalPrice: true,
                sellerOffer: { select: { id: true, name: true } },
              },
            },
          },
          skip: skipSettled,
          take: takeSettled,
        });
      }

      const data = [...settledData, ...projectedSettlements];
      return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
    } catch (error) {
      this.logger.warn(`Failed to fetch settlements: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return { data: [], total: 0, page: query.page || 1, limit: query.limit || 20, totalPages: 0 };
    }
  }

  // getAllSettlements only sums the CURRENT PAGE's amounts client-side, so
  // admin stat cards (Gross/Pending/Settled) drifted whenever there was more
  // than one page of records. This computes true totals across every
  // matching record (same status/seller/date filters, no pagination) so the
  // three numbers are internally consistent: gross === pending + settled.
  async getSettlementsSummary(query: {
    status?: string;
    sellerId?: string;
    orderItemId?: string;
    dateFrom?: string;
    dateTo?: string;
  }) {
    try {
      const { status } = query;
      const { where, pendingWhere } = this.buildSettlementFilters(query);

      let projectedAmount = 0;
      if (!status || status === 'PROJECTED') {
        const pendingItems = (this.prisma as any).orderItem
          ? await this.prisma.orderItem.findMany({
              where: pendingWhere,
              include: {
                sellerOffer: { include: { catalogProduct: true } },
                seller: true,
              },
            })
          : [];
        projectedAmount = pendingItems.reduce((sum: number, item: any) => {
          const input = buildPayoutInputFromOrderItem(item);
          const breakdown = calculateSellerPayout(input);
          return sum + breakdown.netPayout.toNumber();
        }, 0);
      }

      let settledAmount = 0;
      let paidAmount = 0;
      if (!status || status !== 'PROJECTED') {
        const settledRecords = (this.prisma as any).sellerSettlement
          ? await this.prisma.sellerSettlement.findMany({
              where,
              select: { amount: true, payoutStatus: true },
            })
          : [];
        for (const s of settledRecords) {
          const amt = Number(s.amount) || 0;
          settledAmount += amt;
          if (s.payoutStatus === 'PAID') paidAmount += amt;
        }
      }

      const gross = projectedAmount + settledAmount;
      const totalSettled = paidAmount;
      const pending = gross - totalSettled;

      return { gross, pending, totalSettled };
    } catch (error) {
      this.logger.warn(`Failed to compute settlements summary: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return { gross: 0, pending: 0, totalSettled: 0 };
    }
  }

  async markSettlementPaid(
    settlementId: string,
    payoutReference: string,
    paymentProofUrl?: string,
  ) {
    let targetId = settlementId;

    if (settlementId.startsWith('projected-')) {
      const orderItemId = settlementId.replace(/^projected-/, '');
      let existing = await this.prisma.sellerSettlement.findFirst({
        where: { orderItemId },
      });

      if (existing) {
        targetId = existing.id;
      } else {
        // Fetch order item directly to create settlement entry regardless of status
        const item = await this.prisma.orderItem.findUnique({
          where: { id: orderItemId },
          include: {
            sellerOffer: { include: { catalogProduct: true } },
            seller: true,
          },
        });

        if (!item) {
          throw new NotFoundException('Order item not found');
        }

        const input = buildPayoutInputFromOrderItem(item);
        const breakdown = calculateSellerPayout(input);

        existing = await this.prisma.sellerSettlement.create({
          data: {
            sellerId: item.sellerId,
            orderItemId: item.id,
            amount: breakdown.netPayout.toString(),
            grossAmount: breakdown.grossAmount.toString(),
            commission: breakdown.commission.toString(),
            commissionGst: breakdown.commissionGst.toString(),
            fixedFee: '0',
            fixedFeeGst: '0',
            withholdingTax: '0',
            netPayout: breakdown.netPayout.toString(),
            payoutStatus: 'PENDING',
          },
        });

        targetId = existing.id;
      }
    }

    const settlement = await this.prisma.sellerSettlement.findUnique({
      where: { id: targetId },
    });

    if (!settlement) throw new NotFoundException('Settlement not found');
    if (settlement.payoutStatus === 'PAID') {
      throw new BadRequestException('Settlement is already paid');
    }

    const updated = await this.prisma.sellerSettlement.update({
      where: { id: targetId },
      data: {
        payoutStatus: 'PAID',
        payoutReference,
        paymentProofUrl,
        payoutDate: new Date(),
      } as any,
      include: { seller: { select: { id: true, companyName: true } } },
    });

    this.logger.log(`Settlement ${targetId} marked as paid by admin`);

    // Tell the seller, and give them the commission invoice for the fee that
    // was withheld — until now they were paid a net figure with no document
    // explaining the difference. Detached on purpose: this row records that
    // money has moved, and an email that will not send must never undo it.
    void this.payoutEmailService.settlementPaid(targetId);

    return updated;
  }

  async syncSettlements() {
    const orders = await this.prisma.order.findMany({
      where: {
        orderStatus: { not: OrderStatus.CANCELLED },
      },
      include: {
        items: {
          include: {
            sellerOffer: { include: { catalogProduct: true } },
          },
        },
      },
    });

    let createdCount = 0;
    for (const order of orders) {
      for (const item of order.items) {
        const existing = await this.prisma.sellerSettlement.findUnique({
          where: { orderItemId: item.id },
        });

        if (!existing) {
          const input = buildPayoutInputFromOrderItem(item);
          const breakdown = calculateSellerPayout(input);

          await this.prisma.sellerSettlement.create({
            data: {
              sellerId: item.sellerId,
              orderItemId: item.id,
              amount: breakdown.netPayout.toString(),
              grossAmount: breakdown.grossAmount.toString(),
              commission: breakdown.commission.toString(),
              commissionGst: breakdown.commissionGst.toString(),
              fixedFee: '0',
              fixedFeeGst: '0',
              withholdingTax: '0',
              netPayout: breakdown.netPayout.toString(),
              payoutStatus: 'PENDING',
            },
          });
          createdCount++;
        }
      }
    }

    const allItemIds = orders.flatMap((o) => o.items.map((i) => i.id));
    this.logger.log(
      `Sync settlements completed: ${createdCount} new records created.`,
    );
    const syncedSettlements = await this.prisma.sellerSettlement.findMany({
      where: { orderItemId: { in: allItemIds } },
      include: {
        seller: { select: { id: true, companyName: true, userId: true } },
        orderItem: {
          select: {
            id: true,
            orderId: true,
            totalPrice: true,
            sellerOffer: { select: { id: true, name: true } },
          },
        },
      },
    });

    return syncedSettlements;
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // TICKET MANAGEMENT
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  async getAllTickets(query: AdminQueryTicketsDto) {
    const { status, page = 1, limit = 20 } = query;
    const skip = (page - 1) * limit;

    const where: Prisma.TicketWhereInput = {};
    if (status) where.status = status;

    const [data, total] = await Promise.all([
      this.prisma.ticket.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        select: {
          id: true,
          subject: true,
          status: true,
          createdAt: true,
          updatedAt: true,
          user: { select: { id: true, phone: true, role: true } },
          _count: { select: { messages: true } },
        },
        skip,
        take: limit,
      }),
      this.prisma.ticket.count({ where }),
    ]);

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async getTicketById(ticketId: string) {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      include: {
        user: { select: { id: true, phone: true, email: true, role: true } },
        messages: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            senderId: true,
            message: true,
            createdAt: true,
            sender: { select: { id: true, phone: true, role: true } },
          },
        },
      },
    });

    if (!ticket) throw new NotFoundException('Ticket not found');
    return ticket;
  }

  async adminReplyTicket(
    adminUserId: string,
    ticketId: string,
    dto: AdminReplyTicketDto,
  ) {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
    });
    if (!ticket) throw new NotFoundException('Ticket not found');

    const [message] = await this.prisma.$transaction([
      this.prisma.message.create({
        data: {
          ticketId,
          senderId: adminUserId,
          message: dto.message,
        },
        select: { id: true, senderId: true, message: true, createdAt: true },
      }),
      this.prisma.ticket.update({
        where: { id: ticketId },
        data: { status: TicketStatus.IN_PROGRESS },
      }),
    ]);

    this.logger.log(`Admin replied to ticket ${ticketId}`);
    return message;
  }

  async adminUpdateTicketStatus(
    ticketId: string,
    dto: AdminUpdateTicketStatusDto,
  ) {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
    });
    if (!ticket) throw new NotFoundException('Ticket not found');

    const updated = await this.prisma.ticket.update({
      where: { id: ticketId },
      data: { status: dto.status },
      select: {
        id: true,
        subject: true,
        status: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    this.logger.log(
      `Ticket ${ticketId} status changed to ${dto.status} by admin`,
    );
    return updated;
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // NOTIFICATIONS
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  async adminBroadcastNotification(
    adminUserId: string,
    dto: import('./dto/admin-broadcast-notification.dto').AdminBroadcastNotificationDto,
  ) {
    const { target, message } = dto;
    const whereClause: Prisma.UserWhereInput = { status: 'APPROVED' };

    if (target === 'BUYER') {
      whereClause.role = 'BUYER';
    } else if (target === 'SELLER') {
      whereClause.role = 'SELLER';
    }

    // Fetch matching users
    const users = await this.prisma.user.findMany({
      where: whereClause,
      select: { id: true, email: true, phone: true },
    });

    if (users.length === 0) {
      throw new BadRequestException(
        'No active users found for the selected target audience.',
      );
    }

    // Create notifications in bulk
    const notificationsData = users.map((user) => ({
      userId: user.id,
      message,
    }));

    await this.prisma.notification.createMany({
      data: notificationsData,
    });

    // Save broadcast history
    await this.prisma.notificationBroadcast.create({
      data: {
        adminId: adminUserId,
        message,
        target,
        deliveredCount: users.length,
      },
    });

    // Simulate email/SMS triggers
    this.logger.log(
      `Broadcast Notification: Sent to ${users.length} users (Target: ${target}).`,
    );
    users.forEach((u) => {
      if (u.email) {
        // In a real app, this would push to an email queue (SQS, RabbitMQ, Bull)
        this.logger.debug(
          `[MOCK EMAIL] Sending notification to ${u.email}: ${message}`,
        );
      }
    });

    return {
      success: true,
      deliveredCount: users.length,
      target,
    };
  }

  /**
   * Get history of broadcasted notifications.
   */
  async getBroadcastHistory() {
    try {
      if ((this.prisma as any).notificationBroadcast) {
        const broadcasts = await (this.prisma as any).notificationBroadcast.findMany({
          include: {
            admin: {
              select: {
                id: true,
                adminProfile: { select: { displayName: true } },
              },
            },
          },
          orderBy: { createdAt: 'desc' },
        });
        return broadcasts || [];
      }
    } catch (error) {
      this.logger.warn(`Failed to fetch broadcast history: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
    return [];
  }

  async getMyBroadcastHistory(adminId: string) {
    try {
      if ((this.prisma as any).notificationBroadcast) {
        const broadcasts = await (this.prisma as any).notificationBroadcast.findMany({
          where: { adminId },
          orderBy: { createdAt: 'desc' },
        });
        return broadcasts || [];
      }
    } catch (error) {
      this.logger.warn(`Failed to fetch my broadcast history: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
    return [];
  }


  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // ADMIN MANAGEMENT (Role-Based Access)
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  /**
   * The letter codes the previous grant screen wrote ("1 3 5 x"), mapped onto
   * the tab model. Kept so the API can be merged before the admin app is:
   * while the old screen is still live it keeps sending codes, and they must
   * mean the same thing they meant yesterday. The analytics codes (p/q) map
   * to the Dashboard tab, which is what they gated.
   */
  private static readonly LEGACY_PERMISSION_CODES: Record<string, [TabKey, AccessLevel]> = {
    '1': ['users', 'view'], '2': ['users', 'full'],
    '3': ['products', 'view'], '4': ['products', 'full'],
    '5': ['orders', 'view'], '6': ['orders', 'full'],
    '7': ['orders', 'view'], '8': ['orders', 'full'],
    '9': ['settlements', 'view'], a: ['settlements', 'full'],
    b: ['tickets', 'view'], c: ['tickets', 'full'],
    d: ['suggestions', 'view'], e: ['suggestions', 'full'],
    f: ['products', 'view'], g: ['products', 'full'],
    h: ['marketing', 'view'], i: ['marketing', 'full'],
    j: ['notifications', 'view'], k: ['notifications', 'full'],
    l: ['marketing', 'view'], m: ['marketing', 'full'],
    n: ['orders', 'view'], o: ['orders', 'full'],
    p: ['dashboard', 'view'], q: ['dashboard', 'view'],
    r: ['settings', 'view'], s: ['settings', 'full'],
    t: ['admins', 'view'], u: ['admins', 'full'],
    v: ['banners', 'view'], w: ['banners', 'full'],
  };

  /**
   * Works out what to store for a create/update.
   *
   * Order matters. `access` is what the current grant screen sends. A `v2:`
   * string is already in storage format. A non-empty legacy string is
   * translated. Anything else - including an absent or empty value - means
   * Super Admin, which is exactly what an empty permissions column has always
   * meant in this system; changing that here would silently strip access from
   * whoever is edited next.
   */
  private resolveGrantsForWrite(dto: {
    access?: { isSuper?: boolean; tabs?: Record<string, unknown> };
    permissions?: string;
  }): AdminGrants {
    if (dto.access) {
      const { grants, errors } = grantsFromInput(dto.access);
      if (errors.length) throw new BadRequestException(errors.join('; '));
      return grants;
    }

    const raw = (dto.permissions ?? '').trim();
    if (!raw) return SUPER_GRANTS;
    if (raw.startsWith('v2:')) return parseAdminGrants(raw);
    if (raw.includes('x')) return SUPER_GRANTS;

    const tabs: Partial<Record<TabKey, AccessLevel>> = {};
    for (const char of raw.toLowerCase()) {
      const mapped = AdminService.LEGACY_PERMISSION_CODES[char];
      if (!mapped) continue;
      const [tab, level] = mapped;
      // "Manage" beats "View" when both codes are present for one tab.
      if (tabs[tab] !== 'full') tabs[tab] = level;
    }
    return { isSuper: false, tabs };
  }

  /**
   * The shape the admin app renders from, so it never has to parse the stored
   * string itself.
   */
  private toAccessPayload(permissions: string | null | undefined) {
    const grants = parseAdminGrants(permissions);
    return { isSuper: grants.isSuper, tabs: grants.tabs };
  }

  /** Tab groups, labels and levels - one source of truth for the grant screen. */
  getAccessCatalog() {
    return { levels: ACCESS_LEVELS, groups: TAB_GROUPS };
  }

  /**
   * How many Super Admins would remain if `excludeUserId` stopped being one.
   * Guards the "last super admin" rail: without it, one careless edit locks
   * every human out of the panel and only a direct database write gets them
   * back in.
   */
  private async countOtherSuperAdmins(excludeUserId: string): Promise<number> {
    const admins = await this.prisma.user.findMany({
      where: { role: 'ADMIN', id: { not: excludeUserId } },
      select: { adminProfile: { select: { permissions: true } } },
    });
    return admins.filter((admin) => parseAdminGrants(admin.adminProfile?.permissions).isSuper)
      .length;
  }

  /**
   * Get all admins with their profiles and permissions
   */
  async getAdmins() {
    const admins = await this.prisma.user.findMany({
      where: { role: 'ADMIN' },
      select: {
        id: true,
        phone: true,
        email: true,
        status: true,
        createdAt: true,
        adminProfile: {
          select: {
            id: true,
            displayName: true,
            department: true,
            permissions: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return admins.map((admin) => ({
      id: admin.id,
      phone: admin.phone,
      email: admin.email,
      status: admin.status,
      name: admin.adminProfile?.displayName || 'Unknown',
      department: admin.adminProfile?.department,
      permissions: admin.adminProfile?.permissions || '',
      access: this.toAccessPayload(admin.adminProfile?.permissions),
      createdAt: admin.createdAt,
    }));
  }

  /**
   * Get admin by ID with profile
   */
  async getAdminById(adminId: string) {
    const admin = await this.prisma.user.findUnique({
      where: { id: adminId },
      select: {
        id: true,
        phone: true,
        email: true,
        status: true,
        createdAt: true,
        adminProfile: {
          select: {
            id: true,
            displayName: true,
            department: true,
            permissions: true,
          },
        },
      },
    });

    if (!admin || admin.id === null) {
      throw new NotFoundException('Admin not found');
    }

    return {
      id: admin.id,
      phone: admin.phone,
      email: admin.email,
      status: admin.status,
      name: admin.adminProfile?.displayName || 'Unknown',
      department: admin.adminProfile?.department,
      permissions: admin.adminProfile?.permissions || '',
      access: this.toAccessPayload(admin.adminProfile?.permissions),
      createdAt: admin.createdAt,
    };
  }

  /**
   * Create a new admin with tab-level access
   */
  async createAdmin(createAdminDto: any) {
    const { phone, name, department } = createAdminDto;
    const permissions = serializeAdminGrants(this.resolveGrantsForWrite(createAdminDto));

    // Check if user already exists
    const existingUser = await this.prisma.user.findUnique({
      where: { phone },
      include: { adminProfile: true },
    });

    let adminUser;

    if (existingUser) {
      // If the user exists (even as SELLER/BUYER), upgrade their role to ADMIN and upsert the admin profile
      adminUser = await this.prisma.user.update({
        where: { id: existingUser.id },
        data: {
          role: 'ADMIN',
          status: 'PENDING',
          adminProfile: {
            upsert: {
              create: {
                displayName: name,
                department: department || '',
                permissions: permissions || '',
              },
              update: {
                displayName: name,
                department: department || '',
                permissions: permissions || '',
              },
            },
          },
        },
        include: { adminProfile: true },
      });
      this.logger.log(`Existing user ${existingUser.id} role updated/upgraded to ADMIN`);
    } else {
      // Create new admin user
      adminUser = await this.prisma.user.create({
        data: {
          phone,
          email: `admin+${phone}@yukizi.in`,
          password: '', // Will be set on first login via OTP
          role: 'ADMIN',
          status: 'PENDING',
          adminProfile: {
            create: {
              displayName: name,
              department: department || '',
              permissions: permissions || '',
            },
          },
        },
        include: { adminProfile: true },
      });
      this.logger.log(`New admin user created for phone ${phone}`);
    }

    return {
      id: adminUser.id,
      phone: adminUser.phone,
      email: adminUser.email,
      name: adminUser.adminProfile?.displayName,
      department: adminUser.adminProfile?.department,
      permissions: adminUser.adminProfile?.permissions || '',
      access: this.toAccessPayload(adminUser.adminProfile?.permissions),
      createdAt: adminUser.createdAt,
    };
  }

  /**
   * Update admin profile and tab-level access.
   *
   * `actorUserId` is the admin performing the edit - needed for the rails that
   * stop the panel being locked out: nobody may drop their own Super Admin
   * status, and the last Super Admin may not be demoted at all.
   */
  async updateAdmin(actorUserId: string, adminId: string, updateAdminDto: any) {
    const { name, department } = updateAdminDto;

    const admin = await this.prisma.user.findUnique({
      where: { id: adminId },
      include: { adminProfile: true },
    });

    if (!admin || admin.role !== 'ADMIN') {
      throw new NotFoundException('Admin not found');
    }

    const changesAccess =
      updateAdminDto.access !== undefined || updateAdminDto.permissions !== undefined;
    const permissions = changesAccess
      ? serializeAdminGrants(this.resolveGrantsForWrite(updateAdminDto))
      : undefined;

    if (permissions !== undefined) {
      const wasSuper = parseAdminGrants(admin.adminProfile?.permissions).isSuper;
      const willBeSuper = parseAdminGrants(permissions).isSuper;

      if (wasSuper && !willBeSuper) {
        if (actorUserId === adminId) {
          throw new BadRequestException(
            'You cannot remove your own Super Admin access. Ask another Super Admin to do it.',
          );
        }
        if ((await this.countOtherSuperAdmins(adminId)) === 0) {
          throw new BadRequestException(
            'This is the last Super Admin. Promote someone else to Super Admin first.',
          );
        }
      }
    }

    // Update or create admin profile (using upsert to avoid 500 if profile is missing)
    const updatedAdmin = await this.prisma.adminProfile.upsert({
      where: { userId: adminId },
      create: {
        userId: adminId,
        displayName: name || admin.phone,
        department: department || '',
        // No profile row yet and no access specified: match what a missing
        // profile has always meant here rather than silently locking them out.
        permissions: permissions ?? serializeAdminGrants(SUPER_GRANTS),
      },
      update: {
        ...(name && { displayName: name }),
        ...(department !== undefined && { department }),
        ...(permissions !== undefined && { permissions }),
      },
      include: {
        user: {
          select: {
            id: true,
            phone: true,
            email: true,
            createdAt: true,
          },
        },
      },
    });

    return {
      id: updatedAdmin.userId,
      phone: updatedAdmin.user.phone,
      email: updatedAdmin.user.email,
      name: updatedAdmin.displayName,
      department: updatedAdmin.department,
      permissions: updatedAdmin.permissions || '',
      access: this.toAccessPayload(updatedAdmin.permissions),
      createdAt: updatedAdmin.user.createdAt,
    };
  }

  /**
   * Delete an admin. Same lockout rails as updateAdmin: you cannot delete
   * yourself, and the last Super Admin cannot be removed.
   */
  async deleteAdmin(actorUserId: string, adminId: string) {
    const admin = await this.prisma.user.findUnique({
      where: { id: adminId },
      include: { adminProfile: { select: { permissions: true } } },
    });

    if (!admin || admin.role !== 'ADMIN') {
      throw new NotFoundException('Admin not found');
    }

    if (actorUserId === adminId) {
      throw new BadRequestException('You cannot remove your own admin account.');
    }

    if (
      parseAdminGrants(admin.adminProfile?.permissions).isSuper &&
      (await this.countOtherSuperAdmins(adminId)) === 0
    ) {
      throw new BadRequestException(
        'This is the last Super Admin. Promote someone else to Super Admin first.',
      );
    }

    // Delete the user record completely (cascades to adminProfile and other tables automatically)
    await this.prisma.user.delete({
      where: { id: adminId },
    });

    return { success: true, message: 'Admin deleted successfully' };
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // ANALYTICS
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  async getRevenueChart(period: string = '30d') {
    return [
      { name: 'W1', revenue: 0 },
      { name: 'W2', revenue: 0 },
      { name: 'W3', revenue: 0 },
      { name: 'W4', revenue: 0 },
    ];
  }

  async getOrdersChart(period: string = '30d') {
    return [
      { name: 'W1', orders: 0 },
      { name: 'W2', orders: 0 },
      { name: 'W3', orders: 0 },
      { name: 'W4', orders: 0 },
    ];
  }

  async getTopProducts(limit: number = 10) {
    return this.prisma.sellerOffer.findMany({
      take: Number(limit) || 10,
      orderBy: { createdAt: 'desc' },
      select: { id: true, name: true, mrp: true, finalCustomerPayable: true },
    });
  }

  async getTopSellers(limit: number = 10) {
    return this.prisma.sellerProfile.findMany({
      take: Number(limit) || 10,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        companyName: true,
        rating: true,
        user: { select: { phone: true } },
      },
    });
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // GST/PAN VERIFICATION STATUS (Admin Override)
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  async updateBuyerGstPanStatus(
    buyerId: string,
    dto: {
      verified: boolean;
      creditTier?: import('@prisma/client').CreditTier;
    },
  ) {
    const buyer = await this.prisma.buyerProfile.findUnique({
      where: { id: buyerId },
    });

    if (!buyer) {
      throw new NotFoundException('Buyer profile not found');
    }

    const profile = await this.prisma.buyerProfile.update({
      where: { id: buyerId },
      data: {
        verificationStatus: dto.verified ? 'VERIFIED' : 'REJECTED',
        creditTier: dto.verified ? (dto.creditTier ?? null) : null,
      },
    });

    // Also update user status based on verification decision
    await this.prisma.user.update({
      where: { id: buyer.userId },
      data: {
        status: dto.verified ? UserStatus.APPROVED : UserStatus.REJECTED,
      },
    });

    this.logger.log(
      `Buyer ${buyerId} ${dto.verified ? 'approved' : 'rejected'} â€” creditTier: ${dto.creditTier ?? 'none'}`,
    );

    if (dto.verified) {
      await this.notificationsService.notifyUserVerified(buyer.userId, 'BUYER');
    } else {
      await this.notificationsService.notifyUserRejected(buyer.userId, 'BUYER');
    }

    return profile;
  }

  /**
   * Toggles self-ship fulfillment for a seller. Touches ONLY selfShipEnabled —
   * existing orders keep the fulfillmentMode snapshotted at their creation.
   */
  async updateSellerSelfShip(
    sellerId: string,
    dto: { selfShipEnabled: boolean },
  ) {
    const seller = await this.prisma.sellerProfile.findUnique({
      where: { id: sellerId },
      select: { id: true },
    });

    if (!seller) {
      throw new NotFoundException('Seller profile not found');
    }

    return this.prisma.sellerProfile.update({
      where: { id: sellerId },
      data: { selfShipEnabled: dto.selfShipEnabled },
      select: { id: true, companyName: true, selfShipEnabled: true },
    });
  }

  async updateSellerGstPanStatus(
    sellerId: string,
    dto: {
      verified: boolean;
      creditTier?: import('@prisma/client').CreditTier;
    },
  ) {
    const seller = await this.prisma.sellerProfile.findUnique({
      where: { id: sellerId },
    });

    if (!seller) {
      throw new NotFoundException('Seller profile not found');
    }

    const updated = await this.prisma.sellerProfile.update({
      where: { id: sellerId },
      data: {
        verificationStatus: dto.verified ? 'VERIFIED' : 'REJECTED',
        creditTier: dto.verified ? (dto.creditTier ?? null) : null,
      },
    });

    if (dto.verified) {
      await this.notificationsService.notifyUserVerified(
        seller.userId,
        'SELLER',
      );
    } else {
      await this.notificationsService.notifyUserRejected(
        seller.userId,
        'SELLER',
      );
    }

    return updated;
  }

  /**
   * Admin-side edit of a seller KYC/profile details (company, GST/PAN,
   * address, bank account, etc). Keyed by userId, not sellerProfile.id,
   * to match the /admin/users/:id detail page. Delegates to the same
   * SellersService.updateProfile the seller own onboarding form uses,
   * so admin corrections go through identical validation/side-effects.
   */
  async updateSellerProfile(userId: string, dto: UpdateSellerProfileDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.role !== 'SELLER') {
      throw new NotFoundException('Seller not found');
    }
    return this.sellersService.updateProfile(userId, dto);
  }

  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  // SUGGESTIONS (MASTER PRODUCTS)
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

  /** Dedupes and drops the primary id - a category is either primary or extra, never both. */
  private normalizeExtraIds(
    ids: string[] | undefined,
    primaryId: string | undefined,
  ): string[] {
    if (!ids?.length) return [];
    return [...new Set(ids)].filter((id) => id && id !== primaryId);
  }

  async getSuggestions(query: AdminQuerySuggestionsDto) {
    const {
      search,
      categoryId,
      subCategoryId,
      page = 1,
      limit = 20,
      isActive,
      badgeType,
    } = query;
    const skip = (page - 1) * limit;

    const where: Prisma.CatalogProductWhereInput = { deletedAt: null };
    if (categoryId) where.categoryId = categoryId;
    if (subCategoryId) where.subCategoryId = subCategoryId;
    if (isActive === 'true') where.isActive = true;
    if (isActive === 'false') where.isActive = false;

    if (badgeType === 'YUKIZI_CHOICE') where.isYukiziChoice = true;
    if (badgeType === 'BEST_SELLER') where.isBestSeller = true;
    if (badgeType === 'AD') where.isAd = true;

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { manufacturer: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [data, total] = await Promise.all([
      this.prisma.catalogProduct.findMany({
        where,
        include: {
          category: { select: { id: true, name: true } },
          subCategory: { select: { id: true, name: true } },
          extraCategories: { select: { id: true, name: true, slug: true } },
          extraSubCategories: { select: { id: true, name: true, slug: true, categoryId: true } },
          images: { select: { id: true, url: true }, orderBy: [{ order: 'asc' }, { id: 'asc' }] },
          productVariants: true,
        },
        orderBy: { name: 'asc' },
        skip,
        take: limit,
      }),
      this.prisma.catalogProduct.count({ where }),
    ]);

    const mappedData = data.map((item: any) => {
      let meta: any = {};
      if (Array.isArray(item.options)) {
        const metaObj = item.options.find((o: any) => o && o.isMetadata);
        if (metaObj) meta = metaObj;
      }
      return {
        ...item,
        price: meta.price !== undefined ? meta.price : item.mrp,
        unit: meta.unit !== undefined ? meta.unit : item.unit || '1',
        minimumOrderQuantity:
          meta.minimumOrderQuantity !== undefined
            ? meta.minimumOrderQuantity
            : item.minimumOrderQuantity || 1,
        options: Array.isArray(item.options)
          ? item.options.filter((o: any) => !o || !o.isMetadata)
          : item.options,
      };
    });

    return {
      data: mappedData,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getSuggestionById(id: string) {
    const suggestion = await this.prisma.catalogProduct.findUnique({
      where: { id },
      include: {
        category: { select: { id: true, name: true } },
        subCategory: { select: { id: true, name: true } },
        extraCategories: { select: { id: true, name: true, slug: true } },
        extraSubCategories: { select: { id: true, name: true, slug: true, categoryId: true } },

        productVariants: {
          include: {
            sellerOffers: {
              select: {
                id: true,
                seller: { select: { companyName: true } },
                mrp: true,
          finalCustomerPayable: true,
              },
              take: 10,
            },
          },
        },
      },
    });

    if (!suggestion) throw new NotFoundException('Suggestion not found');
    let meta: any = {};
    if (Array.isArray(suggestion.options)) {
      const metaObj = (suggestion.options as any[]).find(
        (o: any) => o && o.isMetadata,
      );
      if (metaObj) meta = metaObj;
    }
    return {
      ...suggestion,
      price: meta.price !== undefined ? meta.price : suggestion.mrp,
      unit:
        meta.unit !== undefined ? meta.unit : (suggestion as any).unit || '1',
      minimumOrderQuantity:
        meta.minimumOrderQuantity !== undefined
          ? meta.minimumOrderQuantity
          : (suggestion as any).minimumOrderQuantity || 1,
      options: Array.isArray(suggestion.options)
        ? (suggestion.options as any[]).filter((o: any) => !o || !o.isMetadata)
        : suggestion.options,
    };
  }

  async createSuggestion(
    dto: import('./dto/update-suggestion.dto').UpdateSuggestionDto,
  ) {
    const skusToCheck = new Set<string>();
    const serialNosToCheck = new Set<string>();
    if (dto.sku) skusToCheck.add(dto.sku);
    if (dto.serialNo) serialNosToCheck.add(dto.serialNo);
    if (dto.variants) {
      for (const v of dto.variants) {
        if (v.sku) skusToCheck.add(v.sku);
        if (v.serialNo) serialNosToCheck.add(v.serialNo);
      }
    }
    
    // Check Variants
    if (skusToCheck.size > 0) {
      const existingVariantSku = await this.prisma.productVariant.findFirst({
        where: { sku: { in: Array.from(skusToCheck) } }
      });
      if (existingVariantSku) {
        const matchedVariant = dto.variants?.find(v => v.sku === existingVariantSku.sku);
        throw new BadRequestException(`SKU "${existingVariantSku.sku}" already exists${matchedVariant ? ` for variant "${matchedVariant.name}"` : ' in another variant'}. Please use a unique SKU.`);
      }
      
      const existingProductSku = await this.prisma.catalogProduct.findFirst({
        where: { sku: { in: Array.from(skusToCheck) } }
      });
      if (existingProductSku) {
        const matchedVariant = dto.variants?.find(v => v.sku === existingProductSku.sku);
        throw new BadRequestException(`SKU "${existingProductSku.sku}" already exists in a product. Please use a unique SKU.`);
      }
    }
    
    if (serialNosToCheck.size > 0) {
      const existingVariantSerial = await this.prisma.productVariant.findFirst({
        where: { serialNo: { in: Array.from(serialNosToCheck) } }
      });
      if (existingVariantSerial) {
        const matchedVariant = dto.variants?.find(v => v.serialNo === existingVariantSerial.serialNo);
        throw new BadRequestException(`Serial No "${existingVariantSerial.serialNo}" already exists${matchedVariant ? ` for variant "${matchedVariant.name}"` : ' in another variant'}. Please use a unique Serial No.`);
      }
      
      // CatalogProduct doesn't have serialNo unique constraint technically right now, but check anyway if we decide to add it
      const existingProductSerial = await this.prisma.catalogProduct.findFirst({
        where: { serialNo: { in: Array.from(serialNosToCheck) } }
      });
      if (existingProductSerial) {
        throw new BadRequestException(`Serial No "${existingProductSerial.serialNo}" already exists in a product. Please use a unique Serial No.`);
      }
    }

    const slug = slugify(`${dto.name}-${dto.manufacturer}`, {
      lower: true,
      strict: true,
    });

    // Resolve Category by name or use a default
    let resolvedCategoryId: string;
    if (dto.categoryId && !dto.categoryId.includes('-')) {
      let cat = await this.prisma.category.findFirst({
        where: { name: { equals: dto.categoryId, mode: 'insensitive' } },
      });
      if (!cat)
        cat = await this.prisma.category.create({
          data: {
            name: dto.categoryId,
            slug: slugify(dto.categoryId, { lower: true }),
          },
        });
      resolvedCategoryId = cat.id;
    } else if (!dto.categoryId) {
      let cat = await this.prisma.category.findFirst({
        where: { name: 'Uncategorized' },
      });
      if (!cat)
        cat = await this.prisma.category.create({
          data: { name: 'Uncategorized', slug: 'uncategorized' },
        });
      resolvedCategoryId = cat.id;
    } else {
      resolvedCategoryId = dto.categoryId;
    }

    // Resolve SubCategory by name or use a default
    let resolvedSubCategoryId: string;
    if (dto.subCategoryId && !dto.subCategoryId.includes('-')) {
      let subCat = await this.prisma.subCategory.findFirst({
        where: {
          name: { equals: dto.subCategoryId, mode: 'insensitive' },
          categoryId: resolvedCategoryId,
        },
      });
      if (!subCat)
        subCat = await this.prisma.subCategory.create({
          data: {
            name: dto.subCategoryId,
            slug: slugify(dto.subCategoryId, { lower: true }),
            categoryId: resolvedCategoryId,
          },
        });
      resolvedSubCategoryId = subCat.id;
    } else if (!dto.subCategoryId) {
      let subCat = await this.prisma.subCategory.findFirst({
        where: { name: 'General', categoryId: resolvedCategoryId },
      });
      if (!subCat)
        subCat = await this.prisma.subCategory.create({
          data: {
            name: 'General',
            slug: 'general',
            categoryId: resolvedCategoryId,
          },
        });
      resolvedSubCategoryId = subCat.id;
    } else {
      resolvedSubCategoryId = dto.subCategoryId;
    }

    const extraCategoryIds = this.normalizeExtraIds(
      dto.extraCategoryIds,
      resolvedCategoryId,
    );
    const extraSubCategoryIds = this.normalizeExtraIds(
      dto.extraSubCategoryIds,
      resolvedSubCategoryId,
    );

    const meta = {
      isMetadata: true,
      price: dto.price !== undefined ? dto.price : (dto.mrp ?? 0),
      unit: dto.unit ?? '1',
      minimumOrderQuantity: dto.minimumOrderQuantity ?? 1,
    };
    const userOptions = Array.isArray(dto.options)
      ? dto.options.filter((o: any) => !o || !o.isMetadata)
      : [];
    const finalOptions = [meta, ...userOptions];

    try {
      const product = await this.prisma.catalogProduct.create({
      data: {
        name: dto.name || '',
        manufacturer: dto.manufacturer || '',

        description: dto.description || '',
        mrp: dto.mrp !== undefined ? dto.mrp : dto.price,
        gstPercent: dto.gstPercent,
        isTaxIncluded: dto.isTaxIncluded ?? false,
        shippingCharges: dto.shippingCharges ?? 0,
        finalShippingPrice: dto.finalShippingPrice ?? null,
        commissionPercent: dto.commissionPercent ?? null,
        fixedFee: dto.fixedFee ?? null,
        commissionGstPercent: dto.commissionGstPercent ?? null,
        fixedFeeGstPercent: dto.fixedFeeGstPercent ?? null,
        shippingGstPercent: dto.shippingGstPercent ?? null,
        sku: dto.sku || null,
        serialNo: dto.serialNo || null,
        specifications: dto.specifications || null,
        categoryId: resolvedCategoryId,
        subCategoryId: resolvedSubCategoryId,
        ...(extraCategoryIds.length
          ? { extraCategories: { connect: extraCategoryIds.map((eid) => ({ id: eid })) } }
          : {}),
        ...(extraSubCategoryIds.length
          ? { extraSubCategories: { connect: extraSubCategoryIds.map((eid) => ({ id: eid })) } }
          : {}),
        packSize: dto.packSize,
        slug,
        options: finalOptions,
        isActive: dto.isActive ?? true,
        isYukiziChoice: dto.isYukiziChoice ?? false,
        isBestSeller: dto.isBestSeller ?? false,
        isAd: dto.isAd ?? false,
        productVariants: dto.variants?.length
          ? {
              create: dto.variants.map((v: any) => ({
                name: v.name,
                sku: v.sku || undefined,
                serialNo: v.serialNo || undefined,
                options: {
                  price: v.price,
                  available: v.available,
                  image: v.image,
                  images: v.images,
                  sku: v.sku,
                  serialNo: v.serialNo,
                  shippingCharges: v.shippingCharges !== undefined ? Number(v.shippingCharges) : 0,
                  finalShippingPrice: v.finalShippingPrice !== undefined ? Number(v.finalShippingPrice) : null,
                  shippingGstPercent: v.shippingGstPercent !== undefined && v.shippingGstPercent !== null ? Number(v.shippingGstPercent) : null,
                },
              })),
            }
          : undefined,
        images: dto.images?.length
          ? {
              create: dto.images.map((url, order) => ({ url, order })),
            }
          : undefined,
      },
      include: {
        category: { select: { id: true, name: true } },
        subCategory: { select: { id: true, name: true } },
        extraCategories: { select: { id: true, name: true, slug: true } },
        extraSubCategories: { select: { id: true, name: true, slug: true, categoryId: true } },
      },
    });
      return product;
    } catch (error: any) {
      if (error.code === 'P2002') {
        const target = error.meta?.target;
        const targetFields = Array.isArray(target) ? target.join(', ') : (typeof target === 'string' ? target : 'unknown field');
        
        if (targetFields.includes('sku')) {
          throw new BadRequestException('SKU already exists. Please use a unique SKU.');
        }
        if (targetFields.includes('serialNo')) {
          throw new BadRequestException('Serial No already exists. Please use a unique Serial No.');
        }
        if (targetFields.includes('slug')) {
          throw new BadRequestException('A product with this name and manufacturer already exists.');
        }
        
        throw new BadRequestException(`A product or variant with this unique field (${targetFields}) already exists.`);
      }
      throw error;
    }
  }

  async updateSuggestion(
    id: string,
    dto: import('./dto/update-suggestion.dto').UpdateSuggestionDto,
  ) {
    if (dto.variants && dto.variants.length > 1) {
      const names = dto.variants.map((v: any) => v.name?.trim().toLowerCase()).filter(Boolean);
      const uniqueNames = new Set(names);
      if (names.length !== uniqueNames.size) {
        throw new BadRequestException('Duplicate variant names are not allowed');
      }
    }

    const skusToCheck = new Set<string>();
    const serialNosToCheck = new Set<string>();
    if (dto.sku) skusToCheck.add(dto.sku);
    if (dto.serialNo) serialNosToCheck.add(dto.serialNo);
    if (dto.variants) {
      for (const v of dto.variants) {
        if (v.sku) skusToCheck.add(v.sku);
        if (v.serialNo) serialNosToCheck.add(v.serialNo);
      }
    }
    
    // Check Variants
    if (skusToCheck.size > 0) {
      const existingVariantSku = await this.prisma.productVariant.findFirst({
        where: { sku: { in: Array.from(skusToCheck) }, catalogProductId: { not: id } }
      });
      if (existingVariantSku) {
        const matchedVariant = dto.variants?.find(v => v.sku === existingVariantSku.sku);
        throw new BadRequestException(`SKU "${existingVariantSku.sku}" already exists${matchedVariant ? ` for variant "${matchedVariant.name}"` : ' in another variant'}. Please use a unique SKU.`);
      }
      
      const existingProductSku = await this.prisma.catalogProduct.findFirst({
        where: { sku: { in: Array.from(skusToCheck) }, id: { not: id } }
      });
      if (existingProductSku) {
        throw new BadRequestException(`SKU "${existingProductSku.sku}" already exists in a product. Please use a unique SKU.`);
      }
    }
    
    if (serialNosToCheck.size > 0) {
      const existingVariantSerial = await this.prisma.productVariant.findFirst({
        where: { serialNo: { in: Array.from(serialNosToCheck) }, catalogProductId: { not: id } }
      });
      if (existingVariantSerial) {
        const matchedVariant = dto.variants?.find(v => v.serialNo === existingVariantSerial.serialNo);
        throw new BadRequestException(`Serial No "${existingVariantSerial.serialNo}" already exists${matchedVariant ? ` for variant "${matchedVariant.name}"` : ' in another variant'}. Please use a unique Serial No.`);
      }
      
      const existingProductSerial = await this.prisma.catalogProduct.findFirst({
        where: { serialNo: { in: Array.from(serialNosToCheck) }, id: { not: id } }
      });
      if (existingProductSerial) {
        throw new BadRequestException(`Serial No "${existingProductSerial.serialNo}" already exists in a product. Please use a unique Serial No.`);
      }
    }

    const suggestion = await this.prisma.catalogProduct.findUnique({
      where: { id },
    });
    if (!suggestion) throw new NotFoundException('Suggestion not found');

    let resolvedCategoryId: string | undefined = undefined;
    if (dto.categoryId && !dto.categoryId.includes('-')) {
      let cat = await this.prisma.category.findFirst({
        where: { name: { equals: dto.categoryId, mode: 'insensitive' } },
      });
      if (!cat)
        cat = await this.prisma.category.create({
          data: {
            name: dto.categoryId,
            slug: slugify(dto.categoryId, { lower: true }),
          },
        });
      resolvedCategoryId = cat.id;
    } else if (dto.categoryId) {
      resolvedCategoryId = dto.categoryId;
    }

    let resolvedSubCategoryId: string | undefined = undefined;
    if (dto.subCategoryId && !dto.subCategoryId.includes('-')) {
      const catId = resolvedCategoryId || suggestion.categoryId;
      let subCat = await this.prisma.subCategory.findFirst({
        where: {
          name: { equals: dto.subCategoryId, mode: 'insensitive' },
          categoryId: catId,
        },
      });
      if (!subCat)
        subCat = await this.prisma.subCategory.create({
          data: {
            name: dto.subCategoryId,
            slug: slugify(dto.subCategoryId, { lower: true }),
            categoryId: catId,
          },
        });
      resolvedSubCategoryId = subCat.id;
    } else if (dto.subCategoryId) {
      resolvedSubCategoryId = dto.subCategoryId;
    }

    let existingMeta: any = {};
    if (Array.isArray(suggestion.options)) {
      const found = (suggestion.options as any[]).find(
        (o: any) => o && o.isMetadata,
      );
      if (found) existingMeta = found;
    }

    const newMeta = {
      ...existingMeta,
      isMetadata: true,
      ...(dto.price !== undefined ? { price: dto.price } : {}),
      ...(dto.unit !== undefined ? { unit: dto.unit } : {}),
      ...(dto.minimumOrderQuantity !== undefined
        ? { minimumOrderQuantity: dto.minimumOrderQuantity }
        : {}),
    };

    let newOptions: any[] = [];
    if (dto.options !== undefined) {
      newOptions = Array.isArray(dto.options)
        ? dto.options.filter((o: any) => !o || !o.isMetadata)
        : [];
    } else if (Array.isArray(suggestion.options)) {
      newOptions = (suggestion.options as any[]).filter(
        (o: any) => !o || !o.isMetadata,
      );
    }

    const finalOptions = [newMeta, ...newOptions];

    try {
      const updated = await this.prisma.catalogProduct.update({
        where: { id },
      data: {
        ...(dto.name ? { name: dto.name } : {}),
        ...(dto.manufacturer ? { manufacturer: dto.manufacturer } : {}),

        ...(dto.description !== undefined
          ? { description: dto.description }
          : {}),
        ...(dto.mrp !== undefined
          ? { mrp: dto.mrp }
          : dto.price !== undefined
            ? { mrp: dto.price }
            : {}),
        ...(dto.packSize !== undefined ? { packSize: dto.packSize } : {}),
        ...(dto.gstPercent !== undefined ? { gstPercent: dto.gstPercent } : {}),
        ...(dto.isTaxIncluded !== undefined ? { isTaxIncluded: dto.isTaxIncluded } : {}),
        ...(dto.commissionPercent !== undefined ? { commissionPercent: dto.commissionPercent ?? null } : {}),
        ...(dto.fixedFee !== undefined ? { fixedFee: dto.fixedFee ?? null } : {}),
        ...(dto.commissionGstPercent !== undefined ? { commissionGstPercent: dto.commissionGstPercent ?? null } : {}),
        ...(dto.fixedFeeGstPercent !== undefined ? { fixedFeeGstPercent: dto.fixedFeeGstPercent ?? null } : {}),
        ...(dto.shippingGstPercent !== undefined ? { shippingGstPercent: dto.shippingGstPercent ?? null } : {}),
        ...(dto.shippingCharges !== undefined ? { shippingCharges: dto.shippingCharges ?? null } : {}),
        ...(dto.finalShippingPrice !== undefined ? { finalShippingPrice: dto.finalShippingPrice ?? null } : {}),
        ...(dto.sku !== undefined ? { sku: dto.sku ?? null } : {}),
        ...(dto.serialNo !== undefined ? { serialNo: dto.serialNo ?? null } : {}),
        ...(dto.specifications !== undefined ? { specifications: dto.specifications ?? null } : {}),
        ...(resolvedCategoryId ? { categoryId: resolvedCategoryId as string } : {}),
        ...(resolvedSubCategoryId
          ? { subCategoryId: resolvedSubCategoryId as string }
          : {}),
        // `set` replaces the stored extras so deselecting works; the field
        // absent means "leave them alone" (older admin builds keep working).
        ...(dto.extraCategoryIds !== undefined
          ? {
              extraCategories: {
                set: this.normalizeExtraIds(
                  dto.extraCategoryIds,
                  resolvedCategoryId ?? suggestion.categoryId,
                ).map((eid) => ({ id: eid })),
              },
            }
          : {}),
        ...(dto.extraSubCategoryIds !== undefined
          ? {
              extraSubCategories: {
                set: this.normalizeExtraIds(
                  dto.extraSubCategoryIds,
                  resolvedSubCategoryId ?? suggestion.subCategoryId,
                ).map((eid) => ({ id: eid })),
              },
            }
          : {}),
        options: finalOptions,
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        ...(dto.isYukiziChoice !== undefined
          ? { isYukiziChoice: dto.isYukiziChoice }
          : {}),
        ...(dto.isBestSeller !== undefined
          ? { isBestSeller: dto.isBestSeller }
          : {}),
        ...(dto.isAd !== undefined ? { isAd: dto.isAd } : {}),
      } as Prisma.CatalogProductUpdateInput,
      include: {
        category: { select: { id: true, name: true } },
        subCategory: { select: { id: true, name: true } },
        extraCategories: { select: { id: true, name: true, slug: true } },
        extraSubCategories: { select: { id: true, name: true, slug: true, categoryId: true } },
      },
    });

    // Propagate product name, manufacturer, and category/subcategory to all connected SellerOffer listings
    if (dto.name || dto.manufacturer || resolvedCategoryId || resolvedSubCategoryId) {
      const offersToUpdate = await this.prisma.sellerOffer.findMany({
        where: {
          OR: [
            { catalogProductId: id },
            { variant: { catalogProductId: id } }
          ]
        },
        include: { variant: true }
      });

      for (const offer of offersToUpdate) {
        const updateFields: any = {};
        if (dto.name) {
          let newOfferName = dto.name;
          if (offer.variant && offer.variant.name && offer.variant.name !== 'Default') {
            newOfferName = `${dto.name} - ${offer.variant.name}`;
          }
          updateFields.name = newOfferName;
          updateFields.slug = slugify(newOfferName, { lower: true }) + '-' + Math.random().toString(36).substring(2, 6);
        }
        if (dto.manufacturer) {
          updateFields.manufacturer = dto.manufacturer;
        }
        if (resolvedCategoryId) {
          updateFields.categoryId = resolvedCategoryId;
        }
        if (resolvedSubCategoryId) {
          updateFields.subCategoryId = resolvedSubCategoryId;
        }

        if (Object.keys(updateFields).length > 0) {
          await this.prisma.sellerOffer.update({
            where: { id: offer.id },
            data: updateFields,
          });
        }
      }
    }

    // Handle variants update if provided
    if (dto.variants !== undefined) {
      const existingVariants = await this.prisma.productVariant.findMany({
        where: { catalogProductId: id },
      });

      const dtoVariantNames = dto.variants.map((v: any) => v.name);

      // 1. Delete variants that are no longer present
      const variantsToDelete = existingVariants.filter(
        (ev) => !dtoVariantNames.includes(ev.name)
      );
      if (variantsToDelete.length > 0) {
        await this.prisma.productVariant.deleteMany({
          where: { id: { in: variantsToDelete.map((v) => v.id) } },
        });
      }

      // 2. Update existing ones (preserving ID) and create new ones
      for (const v of dto.variants) {
        const existing = existingVariants.find((ev) => ev.name === v.name);
        const variantData = {
          sku: v.sku || undefined,
          serialNo: v.serialNo || undefined,
          options: {
            price: v.price,
            available: v.available,
            image: v.image,
            images: v.images,
            sku: v.sku,
            serialNo: v.serialNo,
            shippingCharges: v.shippingCharges !== undefined ? Number(v.shippingCharges) : 0,
            finalShippingPrice: v.finalShippingPrice !== undefined ? Number(v.finalShippingPrice) : null,
            shippingGstPercent: v.shippingGstPercent !== undefined && v.shippingGstPercent !== null ? Number(v.shippingGstPercent) : null,
          },
        };

        if (existing) {
          await this.prisma.productVariant.update({
            where: { id: existing.id },
            data: variantData,
          });
        } else {
          await this.prisma.productVariant.create({
            data: {
              catalogProductId: id,
              name: v.name,
              ...variantData,
            },
          });
        }
      }
    }

    // Handle images update if provided
    if (dto.images) {
      await this.prisma.catalogProductImage.deleteMany({
        where: { masterProductId: id },
      });

      if (dto.images.length > 0) {
        // order preserves the position the admin arranged in the Media
        // grid - the array arrives in that order from the frontend, and
        // there is nothing else on this row (createMany gives every row in
        // one save the same createdAt) that could stand in for it.
        await this.prisma.catalogProductImage.createMany({
          data: dto.images.map((url, order) => ({
            masterProductId: id,
            url,
            order,
          })),
        });
      }
    }

    return updated;
    } catch (error: any) {
      if (error.code === 'P2002') {
        const target = error.meta?.target;
        const targetFields = Array.isArray(target) ? target.join(', ') : (typeof target === 'string' ? target : 'unknown field');
        
        if (targetFields.includes('sku')) {
          throw new BadRequestException('SKU already exists. Please use a unique SKU.');
        }
        if (targetFields.includes('serialNo')) {
          throw new BadRequestException('Serial No already exists. Please use a unique Serial No.');
        }
        if (targetFields.includes('slug')) {
          throw new BadRequestException('A product with this name and manufacturer already exists.');
        }
        
        throw new BadRequestException(`A product or variant with this unique field (${targetFields}) already exists.`);
      }
      throw error;
    }
  }

  async deleteSuggestion(id: string) {
    const suggestion = await this.prisma.catalogProduct.findUnique({
      where: { id },
    });
    if (!suggestion) throw new NotFoundException('Suggestion not found');

    const variants = await this.prisma.productVariant.findMany({
      where: { catalogProductId: id },
      select: { id: true },
    });
    const variantIds = variants.map((v) => v.id);

    // Soft delete, which is what this endpoint has always advertised.
    //
    // It used to hard delete the seller offers and then the product itself.
    // That fails with P2003 for any product that has been ordered, reviewed or
    // put in a marketing slot, because OrderItem.sellerOfferId,
    // Review.sellerOfferId, MarketingProduct.sellerOfferId and
    // CustomOrder.catalogProductId all reference these rows without a cascade.
    // The admin then just saw "Failed to delete" with no way to proceed.
    //
    // Hard deleting was the wrong goal anyway: removing a product that appears
    // on past orders would tear rows out from under order history. Marking it
    // deleted takes it off the storefront and out of this list (both queries
    // filter on deletedAt) while leaving those records intact.
    const deletedAt = new Date();

    return this.prisma.$transaction(async (tx) => {
      await tx.sellerOffer.updateMany({
        where: {
          OR: [
            { catalogProductId: id },
            ...(variantIds.length > 0 ? [{ variantId: { in: variantIds } }] : []),
          ],
          deletedAt: null,
        },
        data: { deletedAt, isActive: false },
      });

      return tx.catalogProduct.update({
        where: { id },
        data: { deletedAt, isActive: false },
      });
    });
  }

  async importSuggestions(
    buffer: Buffer,
  ): Promise<{ success: boolean; recordsProcessed: number; errors: string[] }> {
    const rawRecords: any[] = [];
    const errors: string[] = [];
    let count = 0;

    return new Promise((resolve) => {
      const stream = Readable.from(buffer);

      stream
        .pipe(csv())
        .on('data', (data) => rawRecords.push(data))
        .on('error', (err) => {
          this.logger.error(`CSV Parsing Error: ${err.message}`);
          resolve({
            success: false,
            recordsProcessed: 0,
            errors: [`Parsing error: ${err.message}`],
          });
        })
        .on('end', async () => {
          try {
            this.logger.log(
              `Starting CSV import: ${rawRecords.length} records found`,
            );

            // 1. Filter out empty/invalid rows early
            const records = rawRecords.filter((r) =>
              (r['name'] || r['PRODUCT NAME'])?.trim(),
            );
            if (records.length === 0) {
              return resolve({
                success: true,
                recordsProcessed: 0,
                errors: ['No valid products found in CSV'],
              });
            }

            // 2. Pre-resolve all Categories
            const uniqueCategoryNames = [
              ...new Set(
                records
                  .map((r) => (r['category'] || r['Category'])?.trim())
                  .filter(Boolean),
              ),
            ] as string[];
            const catCache = new Map<string, string>();

            // Load existing
            const existingCats = await this.prisma.category.findMany({
              where: { name: { in: uniqueCategoryNames } },
            });
            existingCats.forEach((c) => catCache.set(c.name, c.id));

            // Create missing
            for (const name of uniqueCategoryNames) {
              if (!catCache.has(name)) {
                const cat = await this.prisma.category.create({
                  data: {
                    name,
                    slug:
                      slugify(name, { lower: true, strict: true }) ||
                      name.toLowerCase(),
                  },
                });
                catCache.set(name, cat.id);
              }
            }

            // Default category
            const defaultCatId = await this.resolveDefaultCategory(catCache);

            // 3. Pre-resolve all Subcategories
            const subCatPairs = new Set<string>(); // "catName|subName"
            records.forEach((r) => {
              const c =
                (r['category'] || r['Category'])?.trim() || 'Uncategorized';
              const s = (r['subCategory'] || r['Sub category'])?.trim();
              if (s) subCatPairs.add(`${c}|${s}`);
            });

            const subCatCache = new Map<string, string>(); // "catName|subName" -> id

            for (const pair of subCatPairs) {
              const [catName, subName] = pair.split('|');
              const categoryId = catCache.get(catName) || defaultCatId;

              let subCat = await this.prisma.subCategory.findFirst({
                where: { name: subName, categoryId },
              });

              if (!subCat) {
                subCat = await this.prisma.subCategory.create({
                  data: {
                    name: subName,
                    slug:
                      slugify(subName, { lower: true, strict: true }) ||
                      subName.toLowerCase(),
                    categoryId,
                  },
                });
              }
              subCatCache.set(pair, subCat.id);
            }

            // Default subcategory per category used
            const defaultSubCatCache = new Map<string, string>(); // catId -> subId

            // 4. Process Products in Chunks
            const CHUNK_SIZE = 50;
            for (let i = 0; i < records.length; i += CHUNK_SIZE) {
              const chunk = records.slice(i, i + CHUNK_SIZE);

              await Promise.all(
                chunk.map(async (row) => {
                  try {
                    const productName = (
                      row['name'] || row['PRODUCT NAME']
                    )?.trim();
                    const manufacturer =
                      (row['manufacturer'] || row['COMPANY NAME'])?.trim() ||
                      'UNKNOWN';

                    const categoryName = (
                      row['category'] || row['Category']
                    )?.trim();
                    const subCategoryName = (
                      row['subCategory'] || row['Sub category']
                    )?.trim();
                    const gstStr = String(
                      row['gstPercent'] || row['GST'] || '0',
                    ).trim();
                    const mrpStr = String(row['mrp'] || '0').trim();
                    const description = row['description']?.trim() || '';
                    const imageUrl = (
                      row['imageUrl'] || row['IMAGE URL']
                    )?.trim();

                    const gstPercent = parseFloat(gstStr.replace('%', '')) || 0;
                    const mrp = parseFloat(mrpStr) || 0;
                    const categoryId =
                      (categoryName && catCache.get(categoryName)) ||
                      defaultCatId;

                    let subCategoryId: string;
                    const subCatLookupKey = `${categoryName || 'Uncategorized'}|${subCategoryName}`;
                    if (subCategoryName && subCatCache.has(subCatLookupKey)) {
                      subCategoryId = subCatCache.get(subCatLookupKey)!;
                    } else {
                      const cachedDefault = defaultSubCatCache.get(categoryId);
                      if (cachedDefault) {
                        subCategoryId = cachedDefault;
                      } else {
                        subCategoryId = await this.resolveDefaultSubCategory(
                          categoryId,
                          defaultSubCatCache,
                        );
                        defaultSubCatCache.set(categoryId, subCategoryId);
                      }
                    }

                    const slug =
                      slugify(`${productName}-${manufacturer}`, {
                        lower: true,
                        strict: true,
                      }) || `p-${Date.now()}-${Math.random()}`;

                    const masterProduct =
                      await this.prisma.catalogProduct.upsert({
                        where: { externalId: (row.id as string) || slug },
                        update: {
                          name: productName,
                          manufacturer,

                          mrp,
                          description,
                          gstPercent,
                          categoryId,
                          subCategoryId,
                          updatedAt: new Date(),
                        },
                        create: {
                          name: productName,
                          slug,
                          externalId: row.id || slug,
                          manufacturer,

                          mrp,
                          description,
                          gstPercent,
                          categoryId,
                          subCategoryId,
                          isActive: true,
                        },
                      });

                    if (imageUrl) {
                      await this.prisma.catalogProductImage.upsert({
                        where: { id: `img-${masterProduct.id}` },
                        update: { url: imageUrl },
                        create: {
                          id: `img-${masterProduct.id}`,
                          masterProductId: masterProduct.id,
                          url: imageUrl,
                        },
                      });
                    }

                    count++;
                  } catch (err) {
                    errors.push(
                      `Row error (${row['PRODUCT NAME']}): ${err.message}`,
                    );
                  }
                }),
              );

              if (i % 500 === 0) {
                this.logger.log(
                  `Import progress: ${i}/${records.length} processed`,
                );
              }
            }

            this.logger.log(
              `Import finished: ${count} records processed, ${errors.length} errors`,
            );
            resolve({
              success: true,
              recordsProcessed: count,
              errors: errors.slice(0, 100),
            }); // Cap error log
          } catch (err) {
            this.logger.error(`Critical CSV Import Error: ${err.message}`);
            resolve({
              success: false,
              recordsProcessed: count,
              errors: [`Global error: ${err.message}`],
            });
          }
        });
    });
  }

  private async resolveDefaultCategory(
    cache: Map<string, string>,
  ): Promise<string> {
    const name = 'Uncategorized';
    if (cache.has(name)) return cache.get(name) as string;
    let cat = await this.prisma.category.findUnique({ where: { name } });
    if (!cat) {
      cat = await this.prisma.category.create({
        data: { name, slug: 'uncategorized' },
      });
    }
    cache.set(name, cat.id);
    return cat.id;
  }

  private async resolveDefaultSubCategory(
    categoryId: string,
    cache: Map<string, string>,
  ): Promise<string> {
    const name = 'General';
    const key = `DEFAULT:${categoryId}`;
    if (cache.has(key)) return cache.get(key) as string;
    let subCat = await this.prisma.subCategory.findFirst({
      where: { name, categoryId },
    });
    if (!subCat) {
      subCat = await this.prisma.subCategory.create({
        data: { name, slug: 'general', categoryId },
      });
    }
    cache.set(key, subCat.id);
    return subCat.id;
  }

  async deleteUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        sellerProfile: true,
        buyerProfile: true,
      },
    });

    if (!user) throw new NotFoundException('User not found');

    this.logger.log(
      `Starting hard delete for user ${userId} (Role: ${user.role})`,
    );

    try {
      return await this.prisma.$transaction(
        async (tx) => {
          // 1. Handle Seller-specific blocks
          if (user.sellerProfile) {
            // Delete settlements where this seller is the recipient
            await tx.sellerSettlement.deleteMany({
              where: { sellerId: user.sellerProfile.id },
            });

            // Delete order items where this seller is involved (prevents blocking SellerProfile/Product deletion)
            // Note: This might leave orders "empty" or with incorrect totals, but hard delete is requested.
            await tx.orderItem.deleteMany({
              where: { sellerId: user.sellerProfile.id },
            });
          }

          // 2. Handle Buyer-specific blocks
          if (user.buyerProfile) {
            // Delete custom orders
            await tx.customOrder.deleteMany({
              where: { buyerId: user.buyerProfile.id },
            });

            // Disconnect referral codes (set buyerId to null)
            await tx.referralCode.updateMany({
              where: { buyerId: user.buyerProfile.id },
              data: { buyerId: null },
            });

            // Handle settlements blocked by buyer's orders
            // When User is deleted, Order is deleted (Cascade), which deletes OrderItem (Cascade).
            // But OrderItem is referenced by SellerSettlement without cascade.
            const buyerOrders = await tx.order.findMany({
              where: { buyerId: userId },
              include: { items: true },
            });
            const orderItemIds = buyerOrders.flatMap((o) =>
              o.items.map((i) => i.id),
            );
            if (orderItemIds.length > 0) {
              await tx.sellerSettlement.deleteMany({
                where: { orderItemId: { in: orderItemIds } },
              });
            }
          }

          // 3. Handle Admin-specific blocks
          if (user.role === 'ADMIN') {
            await tx.notificationBroadcast.deleteMany({
              where: { adminId: userId },
            });
          }

          // 4. Finally, delete the user (this will cascade to profiles, orders, etc.)
          const deleted = await tx.user.delete({
            where: { id: userId },
          });

          this.logger.log(
            `User ${userId} and all related data hard-deleted successfully`,
          );
          return deleted;
        },
        {
          timeout: 15000, // Increase timeout for large deletions
        },
      );
    } catch (error) {
      this.logger.error(
        `Failed to delete user ${userId}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  // ═══════════════════════════════════════════════════
  // PLATFORM SETTINGS
  // ═══════════════════════════════════════════════════

  async getPlatformSettings() {
    const DEFAULT_SETTINGS: Record<string, any> = {
      platformName: 'Yukizi',
      // Blank means "use the storefront's built-in contact details", matching
      // how the SEO defaults behave. These used to default to
      // support@yukizi.in and +91 1800-XXX-XXXX — placeholders nothing ever
      // read, so nobody noticed they were not real contact details.
      supportEmail: '',
      supportPhone: '',
      sessionTimeout: 60,
      maxLoginAttempts: 5,
      otpExpiry: 120,
      fraudAlertEmail: '',
      adminAlertEmail: '',
      mailFromAddress: '',
      allowSellerRegistration: true,
      expressLogin: true,
      creditLineOrders: true,
      maintenanceMode: false,
      comingSoonMode: true,
      // Search-engine ownership verification tokens (Google Search Console /
      // Bing Webmaster Tools). Public-by-nature — they are rendered into
      // every page's <head> as meta tags; storing them here lets an admin
      // connect GSC/Bing without touching Vercel env vars or redeploying.
      googleSiteVerification: '',
      bingSiteVerification: '',
      // Storefront-wide SEO defaults, admin-editable so these never need a
      // developer again. Blank means "use the built-in default".
      seoTitleTemplate: '',        // e.g. "%s | Yukizi"
      seoDefaultDescription: '',   // fallback meta description
      seoDefaultOgImage: '',       // fallback share image URL
      seoTwitterHandle: '',        // @handle for twitter:site
      seoThemeColor: '',           // browser chrome colour
      seoProductTitleSuffix: '',   // appended to generated product titles
      // Social profile URLs. Rendered in the storefront footer AND emitted as
      // schema.org sameAs on the Organization — the link that lets Google and
      // AI assistants connect this site to the brand's presence elsewhere.
      socialInstagram: '',
      socialFacebook: '',
      socialYoutube: '',
      socialX: '',
      socialDiscord: '',
      socialLinkedin: '',
      socialWhatsapp: '',
    };

    try {
      if ((this.prisma as any).systemSetting) {
        const dbSettings = await (this.prisma as any).systemSetting.findMany();
        const result = { ...DEFAULT_SETTINGS };

        for (const item of dbSettings) {
          if (item.value === 'true') {
            result[item.key] = true;
          } else if (item.value === 'false') {
            result[item.key] = false;
          } else if (!isNaN(Number(item.value)) && item.value.trim() !== '') {
            result[item.key] = Number(item.value);
          } else {
            result[item.key] = item.value;
          }
        }
        // The Instagram token is a live credential — it reads the connected
        // account's media. This endpoint hands settings to a browser, so the
        // value never goes back out; the UI only needs to know one is saved.
        if (result[INSTAGRAM_TOKEN_KEY]) {
          result[INSTAGRAM_TOKEN_KEY] = MASKED_SECRET;
        }
        return result;
      }
    } catch (error) {
      this.logger.warn(`Could not fetch system settings from DB: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    return DEFAULT_SETTINGS;
  }

  async updatePlatformSettings(payload: Record<string, any>) {
    try {
      if ((this.prisma as any).systemSetting) {
        const updates = Object.entries(payload)
          // The settings form reads back a masked token, so saving any other
          // field would post the mask straight over the real credential and
          // silently disconnect the feed. Only a genuinely new value counts.
          .filter(([key, value]) => !(key === INSTAGRAM_TOKEN_KEY && String(value) === MASKED_SECRET))
          .map(([key, value]) => {
          const strVal = typeof value === 'object' ? JSON.stringify(value) : String(value);
          return (this.prisma as any).systemSetting.upsert({
            where: { key },
            update: { value: strVal },
            create: { key, value: strVal },
          });
        });
        await Promise.all(updates);
      }
    } catch (error) {
      this.logger.warn(`Could not save system settings to DB: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    return this.getPlatformSettings();
  }

  async getPublicSettings() {
    const settings = await this.getPlatformSettings();
    return {
      comingSoonMode: Boolean(settings.comingSoonMode),
      maintenanceMode: Boolean(settings.maintenanceMode),
      platformName: settings.platformName,
      supportEmail: String(settings.supportEmail ?? ''),
      supportPhone: String(settings.supportPhone ?? ''),
      googleSiteVerification: String(settings.googleSiteVerification ?? ''),
      bingSiteVerification: String(settings.bingSiteVerification ?? ''),
      seoTitleTemplate: String(settings.seoTitleTemplate ?? ''),
      seoDefaultDescription: String(settings.seoDefaultDescription ?? ''),
      seoDefaultOgImage: String(settings.seoDefaultOgImage ?? ''),
      seoTwitterHandle: String(settings.seoTwitterHandle ?? ''),
      seoThemeColor: String(settings.seoThemeColor ?? ''),
      seoProductTitleSuffix: String(settings.seoProductTitleSuffix ?? ''),
      socialInstagram: String(settings.socialInstagram ?? ''),
      socialFacebook: String(settings.socialFacebook ?? ''),
      socialYoutube: String(settings.socialYoutube ?? ''),
      socialX: String(settings.socialX ?? ''),
      socialDiscord: String(settings.socialDiscord ?? ''),
      socialLinkedin: String(settings.socialLinkedin ?? ''),
      socialWhatsapp: String(settings.socialWhatsapp ?? ''),
    };
  }
}


