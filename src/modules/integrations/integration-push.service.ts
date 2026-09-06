import { Injectable, Logger } from '@nestjs/common';
import {
  FulfillmentChannel,
  IntegrationLogStatus,
  IntegrationMappingStatus,
  IntegrationProvider,
  IntegrationStatus,
  IntegrationSyncDirection,
  InventoryEventStatus,
  InventoryEventType,
  SellerIntegration,
} from '@prisma/client';
import * as crypto from 'crypto';
import { PrismaService } from '../../database/prisma.service';
import { EncryptionService } from './encryption.service';
import { IntegrationsService } from './integrations.service';
import { PermanentIntegrationError } from './integration-import.service';
import { ShopifyProvider } from './providers/shopify.provider';
import { WooCommerceProvider } from './providers/woocommerce.provider';
import { AmazonProvider } from './providers/amazon.provider';

/**
 * Writing Yukizi quantities out to a channel.
 *
 * The loop-breaking contract lives here. Before any outbound write, an
 * InventoryEvent is recorded with sourcePlatform 'YUKIZI' and an idempotency
 * key stating the quantity we are about to set. When the channel then sends a
 * webhook saying "inventory is now N", the receiver compares it against that
 * record and recognises it as the echo of our own write rather than news —
 * which is what stops Shopify -> Yukizi -> Woo -> Yukizi -> Shopify running
 * forever.
 *
 * The event is written BEFORE the call, not after: if the request succeeds but
 * the response is lost, the echo still gets recognised.
 */
@Injectable()
export class IntegrationPushService {
  private readonly logger = new Logger(IntegrationPushService.name);

  /** Pause between channel writes, to stay inside per-provider rate limits. */
  private static readonly WRITE_DELAY_MS = 550;
  /** Rows written per job, so one seller cannot monopolise the runner. */
  private static readonly MAX_WRITES_PER_RUN = 40;

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly integrations: IntegrationsService,
    private readonly shopify: ShopifyProvider,
    private readonly woocommerce: WooCommerceProvider,
    private readonly amazon: AmazonProvider,
  ) {}

  /**
   * Pushes the given quantities to one channel.
   *
   * `targets` is a list of mapping ids with the quantity Yukizi believes is
   * correct. Anything the channel owns (Amazon FBA) or that cannot be
   * addressed (a mapping missing its provider handle) is skipped with a
   * reason rather than guessed at.
   */
  async pushQuantities(
    integration: SellerIntegration,
    targets: Array<{ mappingId: string; quantity: number }>,
  ): Promise<{ pushed: number; skipped: number }> {
    if (targets.length === 0) return { pushed: 0, skipped: 0 };

    const credentials = this.encryption.decrypt<Record<string, string>>(
      integration.encryptedCredentials,
    );
    if (!credentials) {
      throw new PermanentIntegrationError(
        'This connection needs to be reauthorized before syncing.',
      );
    }

    // Shopify quantities are per-location, so the location is resolved once
    // per run rather than per row.
    let shopifyLocationId: string | null = null;
    if (integration.provider === IntegrationProvider.SHOPIFY) {
      shopifyLocationId = await this.shopify.fetchPrimaryLocationId(
        integration.externalAccountId,
        credentials.accessToken,
      );
      if (!shopifyLocationId) {
        throw new PermanentIntegrationError(
          'No inventory location was found on this Shopify store.',
        );
      }
    }

    const batch = targets.slice(0, IntegrationPushService.MAX_WRITES_PER_RUN);
    let pushed = 0;
    let skipped = 0;

    for (const [index, target] of batch.entries()) {
      const mapping = await this.prisma.integrationProductMapping.findUnique({
        where: { id: target.mappingId },
      });

      if (
        !mapping ||
        mapping.integrationId !== integration.id ||
        mapping.status !== IntegrationMappingStatus.MAPPED
      ) {
        skipped += 1;
        continue;
      }

      // Amazon's fulfilment centres hold FBA stock. Yukizi displays it and
      // never sets it.
      if (mapping.fulfillmentChannel === FulfillmentChannel.AMAZON_FBA) {
        skipped += 1;
        continue;
      }

      // An unresolved difference means the seller has not said which side is
      // right. Writing now would silently overwrite the number they are being
      // asked about.
      if (mapping.inventoryConflictAt) {
        skipped += 1;
        continue;
      }

      // Already correct as far as we know — nothing to say.
      if (mapping.externalQuantity === target.quantity) {
        skipped += 1;
        continue;
      }

      // Declare the intent BEFORE the call, so the echo is recognised even if
      // the response never comes back.
      const idempotencyKey = crypto.randomUUID();
      const outboundEvent = await this.prisma.inventoryEvent.create({
        data: {
          sellerId: integration.sellerId,
          integrationId: integration.id,
          mappingId: mapping.id,
          sellerOfferId: mapping.sellerOfferId,
          sourcePlatform: 'YUKIZI',
          // No provider event id: this is our own write, and the unique index
          // treats NULLs as distinct so outbound rows never collide.
          sourceEventId: null,
          idempotencyKey,
          eventType: InventoryEventType.YUKIZI_MANUAL_CHANGE,
          status: InventoryEventStatus.PENDING,
          oldQuantity: mapping.externalQuantity,
          newQuantity: target.quantity,
          quantityDelta:
            mapping.externalQuantity === null
              ? null
              : target.quantity - mapping.externalQuantity,
        },
      });

      try {
        await this.writeToChannel(
          integration,
          credentials,
          mapping,
          target.quantity,
          shopifyLocationId,
        );

        await this.prisma.$transaction([
          this.prisma.inventoryEvent.update({
            where: { id: outboundEvent.id },
            data: {
              status: InventoryEventStatus.PROCESSED,
              processedAt: new Date(),
            },
          }),
          this.prisma.integrationProductMapping.update({
            where: { id: mapping.id },
            data: {
              // Record what the channel now holds, so the next comparison and
              // the echo check both have the right baseline.
              externalQuantity: target.quantity,
              externalQuantityAt: new Date(),
              lastSyncedAt: new Date(),
              lastError: null,
            },
          }),
        ]);
        pushed += 1;
      } catch (error) {
        await this.prisma.inventoryEvent.update({
          where: { id: outboundEvent.id },
          data: {
            status: InventoryEventStatus.FAILED,
            lastError: this.sanitize(error),
            processedAt: new Date(),
          },
        });
        // Authorisation failures are the caller's problem to escalate; a
        // single bad row should not abort the rest of the batch.
        if (this.isAuthFailure(error)) throw error;
        await this.prisma.integrationProductMapping.update({
          where: { id: mapping.id },
          data: { lastError: this.sanitize(error) },
        });
        skipped += 1;
      }

      if (index < batch.length - 1) {
        await this.delay(IntegrationPushService.WRITE_DELAY_MS);
      }
    }

    if (pushed > 0) {
      await this.integrations.log(integration.sellerId, integration.id, {
        action: 'INVENTORY_EXPORTED',
        status: IntegrationLogStatus.SUCCESS,
        message: `${pushed} quantit${pushed === 1 ? 'y' : 'ies'} sent to the channel.`,
      });
    }

    return { pushed, skipped };
  }

  /** Dispatches one write to the right provider. */
  private async writeToChannel(
    integration: SellerIntegration,
    credentials: Record<string, string>,
    mapping: {
      externalProductId: string;
      externalVariantId: string;
      externalSku: string | null;
      externalInventoryRef: string | null;
      externalProductType: string | null;
    },
    quantity: number,
    shopifyLocationId: string | null,
  ): Promise<void> {
    switch (integration.provider) {
      case IntegrationProvider.SHOPIFY: {
        if (!mapping.externalInventoryRef || !shopifyLocationId) {
          throw new UnaddressableListingError(
            'This listing is missing its Shopify inventory reference. Run a sync to refresh it.',
          );
        }
        await this.shopify.setInventoryLevel(
          integration.externalAccountId,
          credentials.accessToken,
          mapping.externalInventoryRef,
          shopifyLocationId,
          quantity,
        );
        return;
      }

      case IntegrationProvider.WOOCOMMERCE:
        await this.woocommerce.updateStockQuantity(
          integration.externalStoreUrl ?? '',
          {
            consumerKey: credentials.consumerKey,
            consumerSecret: credentials.consumerSecret,
          },
          mapping.externalProductId,
          mapping.externalVariantId || null,
          quantity,
        );
        return;

      case IntegrationProvider.AMAZON: {
        if (!mapping.externalSku || !mapping.externalProductType) {
          throw new UnaddressableListingError(
            'This Amazon listing is missing the product type needed to update it. Run a sync to refresh it.',
          );
        }
        await this.amazon.setMerchantQuantity(
          {
            refreshToken: credentials.refreshToken,
            sellingPartnerId: credentials.sellingPartnerId ?? '',
            marketplaceId: integration.marketplaceId ?? '',
            region: integration.region ?? 'na',
          },
          mapping.externalSku,
          mapping.externalProductType,
          quantity,
        );
        return;
      }

      default:
        throw new UnaddressableListingError(
          'This channel does not support inventory export.',
        );
    }
  }

  /**
   * Every OTHER connected channel of this seller that carries the same Yukizi
   * listing and is allowed to receive updates.
   *
   * This is the fan-out step, and the reason channels never talk to each
   * other: the source channel is excluded, so an update can travel outward
   * once but never bounce back to where it came from.
   */
  async findFanOutTargets(
    sellerId: string,
    sellerOfferId: string,
    excludeIntegrationId: string | null,
  ): Promise<Array<{ integrationId: string; mappingId: string }>> {
    const mappings = await this.prisma.integrationProductMapping.findMany({
      where: {
        sellerId,
        sellerOfferId,
        status: IntegrationMappingStatus.MAPPED,
        fulfillmentChannel: FulfillmentChannel.MERCHANT,
        inventoryConflictAt: null,
        ...(excludeIntegrationId
          ? { integrationId: { not: excludeIntegrationId } }
          : {}),
        integration: {
          status: IntegrationStatus.CONNECTED,
          syncEnabled: true,
          syncInventory: true,
          setupCompletedAt: { not: null },
          // Import-only channels are a read source; Yukizi must not write back
          // to them.
          inventoryDirection: {
            in: [
              IntegrationSyncDirection.EXPORT_ONLY,
              IntegrationSyncDirection.TWO_WAY,
            ],
          },
        },
      },
      select: { id: true, integrationId: true },
    });

    return mappings.map((m) => ({
      integrationId: m.integrationId,
      mappingId: m.id,
    }));
  }

  private isAuthFailure(error: unknown): boolean {
    const status = (error as { response?: { status?: number } })?.response
      ?.status;
    return (
      error instanceof PermanentIntegrationError ||
      status === 401 ||
      status === 403
    );
  }

  /** Status line only — a provider body can echo request headers. */
  private sanitize(error: unknown): string {
    const status = (error as { response?: { status?: number } })?.response
      ?.status;
    if (status) return `Channel responded with HTTP ${status}`;
    if (error instanceof Error) return error.message.slice(0, 300);
    return 'Unknown error';
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * One listing cannot be addressed on the channel — a missing Shopify inventory
 * reference, a missing Amazon product type.
 *
 * Deliberately NOT a PermanentIntegrationError: that means "the connection is
 * broken, stop everything", whereas this means "skip this row and carry on".
 * Conflating them would let a single incomplete listing abort a whole batch,
 * leaving the rest of the seller's catalogue unsynchronised.
 */
export class UnaddressableListingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnaddressableListingError';
  }
}
