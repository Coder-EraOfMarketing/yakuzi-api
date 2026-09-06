import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import {
  IntegrationLogStatus,
  IntegrationProvider,
  IntegrationStatus,
  IntegrationSyncDirection,
  InventorySourceOfTruth,
  Prisma,
  SellerIntegration,
  SyncJobStatus,
  SyncJobType,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { EncryptionService } from './encryption.service';
import { ShopifyProvider } from './providers/shopify.provider';
import { WooCommerceProvider } from './providers/woocommerce.provider';
import { AmazonProvider } from './providers/amazon.provider';
import {
  CompleteSetupDto,
  UpdateIntegrationSettingsDto,
} from './dto';

/**
 * Everything a seller is allowed to see about a connection. Built by
 * toSellerView() so there is exactly ONE place where the credential fields can
 * leak — and it never selects them.
 */
export interface SellerIntegrationView {
  id: string;
  provider: IntegrationProvider;
  status: IntegrationStatus;
  /** UI-facing health: CONNECTED | SYNCING | PAUSED | ACTION_REQUIRED | DISCONNECTED */
  health: string;
  storeName: string | null;
  storeUrl: string | null;
  marketplaceId: string | null;
  region: string | null;
  scopes: string[];
  syncEnabled: boolean;
  syncProducts: boolean;
  syncInventory: boolean;
  syncPrices: boolean;
  syncOrders: boolean;
  inventoryDirection: IntegrationSyncDirection;
  sourceOfTruth: InventorySourceOfTruth;
  setupCompleted: boolean;
  lastSyncAt: Date | null;
  lastSuccessfulSyncAt: Date | null;
  lastError: string | null;
  connectedAt: Date;
}

@Injectable()
export class IntegrationsService {
  private readonly logger = new Logger(IntegrationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly shopify: ShopifyProvider,
    private readonly woocommerce: WooCommerceProvider,
    private readonly amazon: AmazonProvider,
  ) {}

  // ── Ownership ─────────────────────────────────────────────────────────────

  /**
   * Resolves the signed-in user to their seller profile. Every public method
   * goes through this; nothing accepts a sellerId from the client.
   */
  async resolveSellerId(userId: string): Promise<string> {
    const seller = await this.prisma.sellerProfile.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!seller) throw new NotFoundException('Seller profile not found');
    return seller.id;
  }

  /**
   * Loads an integration and proves it belongs to this seller.
   *
   * Deliberately throws NotFound rather than Forbidden for someone else's id:
   * a Forbidden would confirm the row exists, which is an enumeration oracle
   * across sellers.
   *
   * Public so sibling services (import, job runner) enforce ownership through
   * this exact check rather than writing their own.
   */
  async requireOwnedIntegration(
    sellerId: string,
    integrationId: string,
  ): Promise<SellerIntegration> {
    const integration = await this.prisma.sellerIntegration.findFirst({
      where: { id: integrationId, sellerId },
    });
    if (!integration) throw new NotFoundException('Integration not found');
    return integration;
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  /**
   * The Integrations page payload: one entry per supported provider, whether
   * connected or not, so the UI renders three cards without inventing state.
   */
  async listForSeller(userId: string) {
    const sellerId = await this.resolveSellerId(userId);

    const rows = await this.prisma.sellerIntegration.findMany({
      where: { sellerId },
      orderBy: { createdAt: 'asc' },
    });

    const connected = rows
      .filter((row) => row.status !== IntegrationStatus.DISCONNECTED)
      .map((row) => this.toSellerView(row));

    const providers = [
      IntegrationProvider.SHOPIFY,
      IntegrationProvider.WOOCOMMERCE,
      IntegrationProvider.AMAZON,
    ].map((provider) => ({
      provider,
      available: this.isProviderConfigured(provider),
      integration:
        connected.find((view) => view.provider === provider) ?? null,
    }));

    return {
      providers,
      summary: await this.buildInventorySummary(sellerId),
    };
  }

  /** Whether the platform-level app credentials exist for a provider. */
  private isProviderConfigured(provider: IntegrationProvider): boolean {
    if (!this.encryption.isConfigured()) return false;
    switch (provider) {
      case IntegrationProvider.SHOPIFY:
        return this.shopify.isConfigured();
      case IntegrationProvider.WOOCOMMERCE:
        return this.woocommerce.isConfigured();
      case IntegrationProvider.AMAZON:
        return this.amazon.isConfigured();
      default:
        return false;
    }
  }

  /**
   * Counts across every connected channel for the overview panel. Counts are
   * honest about phase 2 not having run: with no mappings yet these are zero
   * rather than invented.
   */
  private async buildInventorySummary(sellerId: string) {
    const [monitored, mapped, attention, lastSync] = await Promise.all([
      this.prisma.integrationProductMapping.count({ where: { sellerId } }),
      this.prisma.integrationProductMapping.count({
        where: { sellerId, status: 'MAPPED' },
      }),
      this.prisma.integrationProductMapping.count({
        where: { sellerId, status: { in: ['UNMAPPED', 'CONFLICT', 'MISSING_SKU'] } },
      }),
      this.prisma.sellerIntegration.findFirst({
        where: { sellerId, lastSuccessfulSyncAt: { not: null } },
        orderBy: { lastSuccessfulSyncAt: 'desc' },
        select: { lastSuccessfulSyncAt: true },
      }),
    ]);

    return {
      productsMonitored: monitored,
      productsMapped: mapped,
      productsNeedingAttention: attention,
      lastSyncAt: lastSync?.lastSuccessfulSyncAt ?? null,
    };
  }

  /** Detail page payload for one provider. */
  async getByProvider(userId: string, provider: IntegrationProvider) {
    const sellerId = await this.resolveSellerId(userId);
    const integration = await this.prisma.sellerIntegration.findFirst({
      where: {
        sellerId,
        provider,
        status: { not: IntegrationStatus.DISCONNECTED },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!integration) throw new NotFoundException('Integration not found');

    const [activity, runningJob] = await Promise.all([
      this.listActivity(sellerId, integration.id, 1, 20),
      this.findActiveJob(integration.id),
    ]);

    return {
      integration: this.toSellerView(integration),
      activity,
      activeJob: runningJob
        ? {
            id: runningJob.id,
            jobType: runningJob.jobType,
            status: runningJob.status,
            totalItems: runningJob.totalItems,
            processedItems: runningJob.processedItems,
            createdAt: runningJob.createdAt,
          }
        : null,
    };
  }

  /**
   * Seller-facing sync activity. Reads the log table, which is written
   * sanitised — `detail` (admin-only technical context) is never selected.
   */
  async listActivity(
    sellerId: string,
    integrationId: string,
    page = 1,
    limit = 20,
  ) {
    const take = Math.min(100, Math.max(1, limit));
    const skip = (Math.max(1, page) - 1) * take;

    const [rows, total] = await Promise.all([
      this.prisma.integrationLog.findMany({
        where: { sellerId, integrationId },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        select: {
          id: true,
          action: true,
          status: true,
          entityRef: true,
          message: true,
          createdAt: true,
        },
      }),
      this.prisma.integrationLog.count({ where: { sellerId, integrationId } }),
    ]);

    return { data: rows, total, page: Math.max(1, page), limit: take };
  }

  /**
   * Product mappings for the mapping screen. Only rows belonging to this
   * seller's own integration can be reached.
   */
  async listMappings(
    userId: string,
    integrationId: string,
    options: { page?: number; limit?: number; status?: string; search?: string } = {},
  ) {
    const sellerId = await this.resolveSellerId(userId);
    await this.requireOwnedIntegration(sellerId, integrationId);

    const take = Math.min(100, Math.max(1, options.limit ?? 25));
    const skip = (Math.max(1, options.page ?? 1) - 1) * take;

    const where: Prisma.IntegrationProductMappingWhereInput = {
      sellerId,
      integrationId,
    };
    if (options.status) {
      const status = options.status.toUpperCase();
      if (['MAPPED', 'UNMAPPED', 'CONFLICT', 'MISSING_SKU'].includes(status)) {
        where.status = status as Prisma.EnumIntegrationMappingStatusFilter['equals'];
      }
    }
    if (options.search?.trim()) {
      const search = options.search.trim();
      where.OR = [
        { externalSku: { contains: search, mode: 'insensitive' } },
        { yukiziSku: { contains: search, mode: 'insensitive' } },
        { externalTitle: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [rows, total] = await Promise.all([
      this.prisma.integrationProductMapping.findMany({
        where,
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
        skip,
        take,
        include: {
          sellerOffer: { select: { id: true, name: true, sku: true } },
        },
      }),
      this.prisma.integrationProductMapping.count({ where }),
    ]);

    // Counts for the filter chips, computed over the whole channel rather than
    // the current page so the numbers do not change as the seller pages.
    const [mapped, unmapped, conflict, missingSku, inventoryConflicts] =
      await Promise.all([
        this.prisma.integrationProductMapping.count({
          where: { sellerId, integrationId, status: 'MAPPED' },
        }),
        this.prisma.integrationProductMapping.count({
          where: { sellerId, integrationId, status: 'UNMAPPED' },
        }),
        this.prisma.integrationProductMapping.count({
          where: { sellerId, integrationId, status: 'CONFLICT' },
        }),
        this.prisma.integrationProductMapping.count({
          where: { sellerId, integrationId, status: 'MISSING_SKU' },
        }),
        this.prisma.integrationProductMapping.count({
          where: { sellerId, integrationId, inventoryConflictAt: { not: null } },
        }),
      ]);

    return {
      data: rows.map((row) => ({
        id: row.id,
        yukiziProductName: row.sellerOffer?.name ?? null,
        yukiziProductId: row.sellerOfferId,
        yukiziSku: row.yukiziSku ?? row.sellerOffer?.sku ?? null,
        externalTitle: row.externalTitle,
        externalSku: row.externalSku,
        externalProductId: row.externalProductId,
        externalVariantId: row.externalVariantId,
        asin: row.asin,
        fulfillmentChannel: row.fulfillmentChannel,
        status: row.status,
        conflictReason: row.conflictReason,
        externalQuantity: row.externalQuantity,
        // Only present while a difference is unresolved.
        inventoryConflict: row.inventoryConflictAt
          ? {
              yukiziQuantity: row.conflictYukiziQuantity,
              externalQuantity: row.externalQuantity,
              detectedAt: row.inventoryConflictAt,
            }
          : null,
        mappedManually: Boolean(row.mappedManuallyAt),
        lastSyncedAt: row.lastSyncedAt,
      })),
      counts: {
        mapped,
        unmapped,
        conflict,
        missingSku,
        inventoryConflicts,
        total: mapped + unmapped + conflict + missingSku,
      },
      total,
      page: Math.max(1, options.page ?? 1),
      limit: take,
    };
  }

  /**
   * Candidate Yukizi listings for a seller to map an external listing onto.
   * Scoped to the seller's own live listings, and searchable by name or SKU —
   * a seller with a large catalogue cannot pick from an unfiltered dropdown.
   */
  async listMappingCandidates(userId: string, search?: string) {
    const sellerId = await this.resolveSellerId(userId);

    const where: Prisma.SellerOfferWhereInput = { sellerId, deletedAt: null };
    if (search?.trim()) {
      const term = search.trim();
      where.OR = [
        { name: { contains: term, mode: 'insensitive' } },
        { sku: { contains: term, mode: 'insensitive' } },
      ];
    }

    const offers = await this.prisma.sellerOffer.findMany({
      where,
      select: { id: true, name: true, sku: true },
      orderBy: { name: 'asc' },
      take: 50,
    });

    return offers;
  }

  /**
   * Seller resolves a mapping by hand. Required when two external listings
   * share a SKU — Yukizi refuses to guess in that case.
   */
  async mapProduct(
    userId: string,
    integrationId: string,
    mappingId: string,
    sellerOfferId: string,
  ) {
    const sellerId = await this.resolveSellerId(userId);
    await this.requireOwnedIntegration(sellerId, integrationId);

    const mapping = await this.prisma.integrationProductMapping.findFirst({
      where: { id: mappingId, sellerId, integrationId },
    });
    if (!mapping) throw new NotFoundException('Mapping not found');

    // The target listing must also belong to this seller — otherwise a seller
    // could attach their channel listing to a rival's product.
    const offer = await this.prisma.sellerOffer.findFirst({
      where: { id: sellerOfferId, sellerId, deletedAt: null },
      select: { id: true, sku: true, catalogProductId: true },
    });
    if (!offer) {
      throw new NotFoundException('That Yukizi product could not be found.');
    }

    const updated = await this.prisma.integrationProductMapping.update({
      where: { id: mapping.id },
      data: {
        sellerOfferId: offer.id,
        catalogProductId: offer.catalogProductId,
        yukiziSku: offer.sku,
        status: 'MAPPED',
        mappedManuallyAt: new Date(),
        lastError: null,
      },
    });

    await this.log(sellerId, integrationId, {
      action: 'PRODUCT_MAPPED',
      status: IntegrationLogStatus.SUCCESS,
      entityRef: offer.sku ?? updated.externalSku ?? undefined,
      message: 'Product mapped manually.',
    });

    return { id: updated.id, status: updated.status };
  }

  // ── Settings ──────────────────────────────────────────────────────────────

  /**
   * Updates sync preferences.
   *
   * TWO_WAY is refused unless the provider's inbound webhook path exists,
   * because two-way without loop protection is how double-deduction bugs get
   * shipped. Today that means it is not offered at all — the UI marks it
   * "Available after inventory sync is enabled".
   */
  async updateSettings(
    userId: string,
    integrationId: string,
    dto: UpdateIntegrationSettingsDto,
  ) {
    const sellerId = await this.resolveSellerId(userId);
    const integration = await this.requireOwnedIntegration(
      sellerId,
      integrationId,
    );

    if (
      dto.inventoryDirection === IntegrationSyncDirection.TWO_WAY &&
      !this.supportsTwoWaySync(integration.provider)
    ) {
      throw new BadRequestException(
        'Two-way inventory sync is not available for this channel yet.',
      );
    }

    const data: Prisma.SellerIntegrationUpdateInput = {};
    if (dto.syncEnabled !== undefined) data.syncEnabled = dto.syncEnabled;
    if (dto.syncProducts !== undefined) data.syncProducts = dto.syncProducts;
    if (dto.syncInventory !== undefined) data.syncInventory = dto.syncInventory;
    if (dto.inventoryDirection !== undefined) {
      data.inventoryDirection = dto.inventoryDirection;
    }
    if (dto.sourceOfTruth !== undefined) data.sourceOfTruth = dto.sourceOfTruth;

    // Pausing is a status the seller can see, not just a flag.
    if (dto.syncEnabled === false && integration.status === IntegrationStatus.CONNECTED) {
      data.status = IntegrationStatus.PAUSED;
    }
    if (dto.syncEnabled === true && integration.status === IntegrationStatus.PAUSED) {
      data.status = IntegrationStatus.CONNECTED;
    }

    const updated = await this.prisma.sellerIntegration.update({
      where: { id: integration.id },
      data,
    });

    await this.log(sellerId, integration.id, {
      action: 'SETTINGS_UPDATED',
      status: IntegrationLogStatus.SUCCESS,
      message: 'Synchronization settings updated.',
    });

    return this.toSellerView(updated);
  }

  /**
   * Two-way sync requires an inbound event path so Yukizi can recognise the
   * echo of its own write, otherwise every push would come back as news and
   * bounce around the connected channels forever.
   *
   * Shopify and WooCommerce both have signature-verified webhook receivers and
   * registered subscriptions, so they qualify. Amazon does not: SP-API
   * notifications need an SQS destination Yukizi does not operate yet, so its
   * inbound path is the periodic sweep, which is too coarse to distinguish an
   * echo from a real change. Amazon therefore stays import- or export-only.
   */
  private supportsTwoWaySync(provider: IntegrationProvider): boolean {
    return (
      provider === IntegrationProvider.SHOPIFY ||
      provider === IntegrationProvider.WOOCOMMERCE
    );
  }

  /** Finishes the post-connect wizard and unlocks sync jobs. */
  async completeSetup(
    userId: string,
    integrationId: string,
    dto: CompleteSetupDto,
  ) {
    const sellerId = await this.resolveSellerId(userId);
    const integration = await this.requireOwnedIntegration(
      sellerId,
      integrationId,
    );

    if (
      dto.inventoryDirection === IntegrationSyncDirection.TWO_WAY &&
      !this.supportsTwoWaySync(integration.provider)
    ) {
      throw new BadRequestException(
        'Two-way inventory sync is not available for this channel yet.',
      );
    }

    const updated = await this.prisma.sellerIntegration.update({
      where: { id: integration.id },
      data: {
        syncProducts: dto.syncProducts,
        syncInventory: dto.syncInventory,
        inventoryDirection: dto.inventoryDirection,
        sourceOfTruth: dto.sourceOfTruth,
        setupCompletedAt: new Date(),
      },
    });

    await this.log(sellerId, integration.id, {
      action: 'SETUP_COMPLETED',
      status: IntegrationLogStatus.SUCCESS,
      message: 'Connection setup completed.',
    });

    // Finishing setup is what starts the first import — the seller has just
    // told us what to sync, so there is nothing left to wait for. Queued, not
    // run inline: a catalogue import must never block this request.
    if (dto.syncProducts || dto.syncInventory) {
      const alreadyQueued = await this.findActiveJob(integration.id);
      if (!alreadyQueued) {
        await this.prisma.integrationSyncJob.create({
          data: {
            sellerId,
            integrationId: integration.id,
            jobType: SyncJobType.INITIAL_IMPORT,
          },
        });
        await this.log(sellerId, integration.id, {
          action: 'IMPORT_QUEUED',
          status: IntegrationLogStatus.SUCCESS,
          message: 'Initial product import queued.',
        });
      }

      // Subscribe to the channel's change notifications. Without this the
      // webhook receivers can never fire — Shopify is never asked to send
      // anything, and WooCommerce deliveries have no secret to verify against.
      // Queued separately so a store that blocks webhook creation still gets
      // its catalogue imported.
      if (dto.syncInventory) {
        await this.prisma.integrationSyncJob.create({
          data: {
            sellerId,
            integrationId: integration.id,
            jobType: SyncJobType.WEBHOOK_REGISTRATION,
            runAfter: new Date(Date.now() + 3_000),
          },
        });
      }
    }

    return this.toSellerView(updated);
  }

  // ── Jobs ──────────────────────────────────────────────────────────────────

  private async findActiveJob(integrationId: string) {
    return this.prisma.integrationSyncJob.findFirst({
      where: {
        integrationId,
        status: { in: [SyncJobStatus.PENDING, SyncJobStatus.PROCESSING] },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * "Sync Now" — enqueues work rather than doing it in the request.
   *
   * Clicking twice must not create two jobs: if one is already pending or
   * processing for this integration we return that one instead of queueing
   * another.
   */
  async requestSync(userId: string, integrationId: string) {
    const sellerId = await this.resolveSellerId(userId);
    const integration = await this.requireOwnedIntegration(
      sellerId,
      integrationId,
    );

    if (integration.status === IntegrationStatus.DISCONNECTED) {
      throw new BadRequestException('This channel is not connected.');
    }
    if (
      integration.status === IntegrationStatus.ERROR ||
      integration.status === IntegrationStatus.EXPIRED
    ) {
      throw new BadRequestException(
        'Reconnect this channel before syncing again.',
      );
    }
    if (!integration.setupCompletedAt) {
      throw new BadRequestException(
        'Finish the connection setup before running a sync.',
      );
    }

    const existing = await this.findActiveJob(integration.id);
    if (existing) {
      return {
        id: existing.id,
        status: existing.status,
        alreadyQueued: true,
      };
    }

    const job = await this.prisma.integrationSyncJob.create({
      data: {
        sellerId,
        integrationId: integration.id,
        jobType: SyncJobType.RECONCILIATION,
        status: SyncJobStatus.PENDING,
      },
    });

    await this.log(sellerId, integration.id, {
      action: 'SYNC_REQUESTED',
      status: IntegrationLogStatus.SUCCESS,
      message: 'Sync queued.',
    });

    return { id: job.id, status: job.status, alreadyQueued: false };
  }

  // ── Disconnect ────────────────────────────────────────────────────────────

  /**
   * Disconnects a channel.
   *
   * Yukizi products are NEVER deleted — only the connection and its
   * credentials go. Mappings are kept so reconnecting the same store does not
   * lose the seller's manual mapping work, but they are marked so nothing
   * treats them as live.
   */
  async disconnect(userId: string, integrationId: string) {
    const sellerId = await this.resolveSellerId(userId);
    const integration = await this.requireOwnedIntegration(
      sellerId,
      integrationId,
    );

    await this.revokeExternalArtifacts(integration);

    await this.prisma.$transaction([
      // Cancel queued work first so nothing picks the job up mid-teardown.
      this.prisma.integrationSyncJob.updateMany({
        where: {
          integrationId: integration.id,
          status: { in: [SyncJobStatus.PENDING, SyncJobStatus.PROCESSING] },
        },
        data: {
          status: SyncJobStatus.FAILED,
          permanentFailure: true,
          lastError: 'Integration disconnected.',
          completedAt: new Date(),
        },
      }),
      this.prisma.integrationWebhook.deleteMany({
        where: { integrationId: integration.id },
      }),
      this.prisma.sellerIntegration.update({
        where: { id: integration.id },
        data: {
          status: IntegrationStatus.DISCONNECTED,
          // The credential is destroyed, not merely orphaned.
          encryptedCredentials: null,
          scopes: [],
          syncEnabled: false,
          setupCompletedAt: null,
          disconnectedAt: new Date(),
          lastError: null,
          lastErrorAt: null,
        },
      }),
    ]);

    await this.log(sellerId, integration.id, {
      action: 'DISCONNECTED',
      status: IntegrationLogStatus.SUCCESS,
      message: 'Channel disconnected. Yukizi products were not changed.',
    });

    return { disconnected: true };
  }

  /**
   * Best-effort removal of what we created on the seller's store. A failure
   * here must not block the disconnect: the seller's intent is to stop, and
   * the credential is being destroyed either way.
   */
  private async revokeExternalArtifacts(
    integration: SellerIntegration,
  ): Promise<void> {
    const credentials = this.encryption.decrypt<Record<string, string>>(
      integration.encryptedCredentials,
    );
    if (!credentials) return;

    const webhooks = await this.prisma.integrationWebhook.findMany({
      where: { integrationId: integration.id },
    });

    try {
      if (
        integration.provider === IntegrationProvider.SHOPIFY &&
        credentials.accessToken &&
        integration.externalAccountId
      ) {
        for (const webhook of webhooks) {
          await this.shopify.deleteWebhook(
            integration.externalAccountId,
            credentials.accessToken,
            webhook.externalId,
          );
        }
      } else if (
        integration.provider === IntegrationProvider.WOOCOMMERCE &&
        credentials.consumerKey &&
        integration.externalStoreUrl
      ) {
        for (const webhook of webhooks) {
          await this.woocommerce.deleteWebhook(
            integration.externalStoreUrl,
            {
              consumerKey: credentials.consumerKey,
              consumerSecret: credentials.consumerSecret,
              keyPermissions: credentials.keyPermissions ?? 'read_write',
              storeUrl: integration.externalStoreUrl,
            },
            webhook.externalId,
          );
        }
      } else if (
        integration.provider === IntegrationProvider.AMAZON &&
        credentials.refreshToken
      ) {
        // Amazon authorisation is revoked by the seller in Seller Central;
        // there is no API to revoke it from our side. Dropping the cached
        // access token is what we can do.
        this.amazon.forgetAccessToken(credentials.refreshToken);
      }
    } catch (error) {
      this.logger.warn(
        `Cleanup of external artifacts failed for integration ${integration.id}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }

  // ── Shared helpers ────────────────────────────────────────────────────────

  /**
   * The ONLY function that turns a database row into something a seller
   * receives. Credential columns are never referenced here, so no future field
   * addition can accidentally serialise a token.
   */
  toSellerView(row: SellerIntegration): SellerIntegrationView {
    return {
      id: row.id,
      provider: row.provider,
      status: row.status,
      health: this.deriveHealth(row),
      storeName: row.externalStoreName,
      storeUrl: row.externalStoreUrl,
      marketplaceId: row.marketplaceId,
      region: row.region,
      scopes: row.scopes,
      syncEnabled: row.syncEnabled,
      syncProducts: row.syncProducts,
      syncInventory: row.syncInventory,
      syncPrices: row.syncPrices,
      syncOrders: row.syncOrders,
      inventoryDirection: row.inventoryDirection,
      sourceOfTruth: row.sourceOfTruth,
      setupCompleted: Boolean(row.setupCompletedAt),
      lastSyncAt: row.lastSyncAt,
      lastSuccessfulSyncAt: row.lastSuccessfulSyncAt,
      lastError: row.lastError,
      connectedAt: row.createdAt,
    };
  }

  /**
   * Maps the stored status onto the five UI health states. ERROR and EXPIRED
   * both surface as ACTION_REQUIRED so the seller is shown "Reconnect" rather
   * than a connection that silently never syncs.
   */
  private deriveHealth(row: SellerIntegration): string {
    switch (row.status) {
      case IntegrationStatus.CONNECTED:
        return 'CONNECTED';
      case IntegrationStatus.PAUSED:
        return 'PAUSED';
      case IntegrationStatus.ERROR:
      case IntegrationStatus.EXPIRED:
        return 'ACTION_REQUIRED';
      default:
        return 'DISCONNECTED';
    }
  }

  /**
   * Writes an audit line. `detail` is admin-only and must never contain a
   * credential — callers pass sanitised context only.
   */
  async log(
    sellerId: string,
    integrationId: string | null,
    entry: {
      action: string;
      status: IntegrationLogStatus;
      entityRef?: string;
      message?: string;
      detail?: Prisma.InputJsonValue;
    },
  ): Promise<void> {
    try {
      await this.prisma.integrationLog.create({
        data: {
          sellerId,
          integrationId,
          action: entry.action,
          status: entry.status,
          entityRef: entry.entityRef,
          message: entry.message,
          detail: entry.detail,
        },
      });
    } catch (error) {
      // Logging must never break the operation it describes.
      this.logger.warn(
        `Could not write integration log (${entry.action}): ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }

  /** Marks a connection unhealthy so the UI shows Reconnect. */
  async markActionRequired(
    integrationId: string,
    status: IntegrationStatus,
    sellerMessage: string,
  ): Promise<void> {
    await this.prisma.sellerIntegration.update({
      where: { id: integrationId },
      data: { status, lastError: sellerMessage, lastErrorAt: new Date() },
    });
  }
}
