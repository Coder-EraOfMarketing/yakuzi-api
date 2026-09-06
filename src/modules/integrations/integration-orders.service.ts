import { Injectable, Logger } from '@nestjs/common';
import {
  IntegrationLogStatus,
  IntegrationProvider,
  Prisma,
  SellerIntegration,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { EncryptionService } from './encryption.service';
import { IntegrationsService } from './integrations.service';
import { PermanentIntegrationError } from './integration-import.service';
import { ShopifyProvider } from './providers/shopify.provider';
import { WooCommerceProvider } from './providers/woocommerce.provider';
import { AmazonProvider } from './providers/amazon.provider';
import {
  ExternalOrder,
  ExternalOrderPage,
} from './providers/external-product.types';

/**
 * Channel order visibility.
 *
 * These orders are recorded in `integration_external_orders` and never as
 * Yukizi `Order` rows. That separation is not tidiness — it is the whole
 * safety property:
 *
 *  - Seller settlements are computed by querying `order_items`, so a Shopify
 *    sale written there would make Yukizi owe the seller money for an order it
 *    never processed and never collected payment for.
 *  - `Order.buyerId` is a required foreign key to `User`, so importing would
 *    mean fabricating buyer accounts for another platform's customers.
 *
 * IMPORTANT — orders deliberately do NOT move stock.
 *
 * Inventory already arrives as an ABSOLUTE quantity from the channel (webhook
 * or reconciliation), and absolute values are idempotent. Applying an order as
 * a delta on top of that would deduct the same sale twice: once when the
 * channel reports the new level, and again when the order is imported. Orders
 * are therefore a reporting surface, and inventory stays the single path that
 * moves stock.
 */
@Injectable()
export class IntegrationOrdersService {
  private readonly logger = new Logger(IntegrationOrdersService.name);

  /** How far back a first import reaches. */
  private static readonly INITIAL_WINDOW_DAYS = 30;
  /** Pages per run, so one busy store cannot monopolise the runner. */
  private static readonly MAX_PAGES_PER_RUN = 5;

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly integrations: IntegrationsService,
    private readonly shopify: ShopifyProvider,
    private readonly woocommerce: WooCommerceProvider,
    private readonly amazon: AmazonProvider,
  ) {}

  /**
   * Imports orders placed since the newest one already stored, falling back to
   * a 30-day window on a first run.
   */
  async importOrders(
    integration: SellerIntegration,
    startCursor?: string | null,
  ): Promise<{ imported: number; nextCursor: string | null }> {
    const credentials = this.encryption.decrypt<Record<string, string>>(
      integration.encryptedCredentials,
    );
    if (!credentials) {
      throw new PermanentIntegrationError(
        'This connection needs to be reauthorized before importing orders.',
      );
    }

    const since = await this.resolveSince(integration.id);

    let cursor: string | null = startCursor ?? null;
    let pages = 0;
    let imported = 0;

    do {
      const page = await this.fetchPage(integration, credentials, since, cursor);
      for (const order of page.orders) {
        await this.upsertOrder(integration, order);
        imported += 1;
      }
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < IntegrationOrdersService.MAX_PAGES_PER_RUN);

    if (imported > 0) {
      await this.integrations.log(integration.sellerId, integration.id, {
        action: 'ORDERS_IMPORTED',
        status: IntegrationLogStatus.SUCCESS,
        message: `${imported} channel order${imported === 1 ? '' : 's'} imported.`,
      });
    }

    return { imported, nextCursor: cursor };
  }

  /**
   * Resume point: the most recent order already stored, minus a day of overlap
   * so an order that arrived while the last run was in flight is not missed.
   */
  private async resolveSince(integrationId: string): Promise<Date> {
    const newest = await this.prisma.integrationExternalOrder.findFirst({
      where: { integrationId },
      orderBy: { placedAt: 'desc' },
      select: { placedAt: true },
    });

    if (!newest) {
      return new Date(
        Date.now() -
          IntegrationOrdersService.INITIAL_WINDOW_DAYS * 24 * 60 * 60 * 1000,
      );
    }
    return new Date(newest.placedAt.getTime() - 24 * 60 * 60 * 1000);
  }

  private async fetchPage(
    integration: SellerIntegration,
    credentials: Record<string, string>,
    since: Date,
    cursor: string | null,
  ): Promise<ExternalOrderPage> {
    switch (integration.provider) {
      case IntegrationProvider.SHOPIFY:
        return this.shopify.fetchOrdersPage(
          integration.externalAccountId,
          credentials.accessToken,
          since,
          cursor,
        );

      case IntegrationProvider.WOOCOMMERCE:
        return this.woocommerce.fetchOrdersPage(
          integration.externalStoreUrl ?? '',
          {
            consumerKey: credentials.consumerKey,
            consumerSecret: credentials.consumerSecret,
          },
          since,
          cursor ? Number(cursor) : 1,
        );

      case IntegrationProvider.AMAZON:
        return this.amazon.fetchOrdersPage(
          {
            refreshToken: credentials.refreshToken,
            sellingPartnerId: credentials.sellingPartnerId ?? '',
            marketplaceId: integration.marketplaceId ?? '',
            region: integration.region ?? 'na',
          },
          since,
          cursor,
        );

      default:
        return { orders: [], nextCursor: null };
    }
  }

  /** Upsert keyed on the channel's own order id, so a re-import updates. */
  private async upsertOrder(
    integration: SellerIntegration,
    order: ExternalOrder,
  ): Promise<void> {
    const shared = {
      orderNumber: order.orderNumber,
      placedAt: order.placedAt,
      status: order.status,
      financialStatus: order.financialStatus,
      currency: order.currency,
      totalAmount: new Prisma.Decimal(order.totalAmount || 0),
      itemCount: order.items.reduce((sum, line) => sum + line.quantity, 0),
      items: order.items as unknown as Prisma.InputJsonValue,
      cancelledAt: order.cancelledAt,
    };

    await this.prisma.integrationExternalOrder.upsert({
      where: {
        integrationId_externalOrderId: {
          integrationId: integration.id,
          externalOrderId: order.externalOrderId,
        },
      },
      create: {
        sellerId: integration.sellerId,
        integrationId: integration.id,
        externalOrderId: order.externalOrderId,
        ...shared,
      },
      update: shared,
    });
  }

  /**
   * Channel orders for the seller's dashboard, newest first.
   * Scoped by seller; an integration id from someone else returns nothing.
   */
  async listOrders(
    userId: string,
    options: { page?: number; limit?: number; integrationId?: string } = {},
  ) {
    const sellerId = await this.integrations.resolveSellerId(userId);
    const take = Math.min(100, Math.max(1, options.limit ?? 25));
    const skip = (Math.max(1, options.page ?? 1) - 1) * take;

    const where: Prisma.IntegrationExternalOrderWhereInput = { sellerId };
    if (options.integrationId) where.integrationId = options.integrationId;

    const [rows, total] = await Promise.all([
      this.prisma.integrationExternalOrder.findMany({
        where,
        orderBy: { placedAt: 'desc' },
        skip,
        take,
        include: {
          integration: { select: { provider: true, externalStoreName: true } },
        },
      }),
      this.prisma.integrationExternalOrder.count({ where }),
    ]);

    return {
      data: rows.map((row) => ({
        id: row.id,
        provider: row.integration.provider,
        storeName: row.integration.externalStoreName,
        orderNumber: row.orderNumber ?? row.externalOrderId,
        placedAt: row.placedAt,
        status: row.status,
        financialStatus: row.financialStatus,
        currency: row.currency,
        totalAmount: Number(row.totalAmount),
        itemCount: row.itemCount,
        cancelled: Boolean(row.cancelledAt),
        items: row.items,
      })),
      total,
      page: Math.max(1, options.page ?? 1),
      limit: take,
    };
  }
}
