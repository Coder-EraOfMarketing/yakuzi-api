import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  IntegrationLogStatus,
  IntegrationSyncDirection,
  InventoryEvent,
  InventoryEventStatus,
  SyncJobStatus,
  SyncJobType,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { InventoryService } from '../products/services/inventory.service';
import { IntegrationsService } from './integrations.service';
import { IntegrationPushService } from './integration-push.service';

/**
 * The inventory engine: turns recorded channel events into Yukizi stock, then
 * decides which other channels need telling.
 *
 *   Shopify ─┐
 * WooCommerce ┼──▶  this service  ──▶ push jobs for the OTHER channels
 *    Amazon ─┘
 *
 * Channels never update each other directly. An event is applied to Yukizi
 * exactly once, and the fan-out excludes the channel it came from, so an
 * update travels outward once and cannot bounce back.
 *
 * Runs on a cron rather than inline in the webhook request: a webhook must be
 * acknowledged in milliseconds, and applying a change may mean writing to
 * three other platforms.
 */
@Injectable()
export class IntegrationEventsService {
  private readonly logger = new Logger(IntegrationEventsService.name);

  /** Events drained per tick. */
  private static readonly BATCH_SIZE = 50;

  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly integrations: IntegrationsService,
    private readonly push: IntegrationPushService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async handleCron(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.processPending();
    } catch (error) {
      this.logger.error(
        `Inventory event tick failed: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    } finally {
      this.running = false;
    }
  }

  /** Public so tests and an admin trigger can drive it directly. */
  async processPending(): Promise<{ processed: number; skipped: number }> {
    const events = await this.prisma.inventoryEvent.findMany({
      where: {
        status: InventoryEventStatus.PENDING,
        // Outbound writes are settled by the push service itself.
        sourcePlatform: { not: 'YUKIZI' },
      },
      orderBy: { receivedAt: 'asc' },
      take: IntegrationEventsService.BATCH_SIZE,
    });

    let processed = 0;
    let skipped = 0;

    for (const event of events) {
      const claimed = await this.claim(event.id);
      if (!claimed) continue; // Another instance took it.

      try {
        const outcome = await this.applyEvent(event);
        if (outcome === 'APPLIED') processed += 1;
        else skipped += 1;
      } catch (error) {
        await this.prisma.inventoryEvent.update({
          where: { id: event.id },
          data: {
            status: InventoryEventStatus.FAILED,
            lastError:
              error instanceof Error
                ? error.message.slice(0, 300)
                : 'Unknown error',
            processedAt: new Date(),
          },
        });
        this.logger.warn(`Inventory event ${event.id} failed to apply`);
      }
    }

    return { processed, skipped };
  }

  /**
   * Compare-and-swap claim, so two instances cannot apply one event twice.
   * This is the second half of the idempotency guarantee: the unique index
   * stops a duplicate being recorded, and this stops a recorded one being
   * applied more than once.
   */
  private async claim(eventId: string): Promise<boolean> {
    const result = await this.prisma.inventoryEvent.updateMany({
      where: { id: eventId, status: InventoryEventStatus.PENDING },
      data: { status: InventoryEventStatus.PROCESSED, processedAt: new Date() },
    });
    return result.count === 1;
  }

  /**
   * Applies one external change to Yukizi and fans out.
   *
   * Returns 'SKIPPED' when the event cannot or must not move stock — an
   * unmapped listing, a channel the seller has set to export-only (so its
   * numbers are not authoritative), or an unresolved difference.
   */
  private async applyEvent(event: InventoryEvent): Promise<'APPLIED' | 'SKIPPED'> {
    if (!event.mappingId || event.newQuantity === null) {
      await this.markSkipped(event.id, 'NO_MAPPING');
      return 'SKIPPED';
    }

    const mapping = await this.prisma.integrationProductMapping.findUnique({
      where: { id: event.mappingId },
      include: { integration: true },
    });

    if (!mapping?.sellerOfferId || !mapping.integration) {
      await this.markSkipped(event.id, 'NO_MAPPING');
      return 'SKIPPED';
    }

    const integration = mapping.integration;

    // Export-only means Yukizi drives this channel; what it reports back is
    // not a source of truth and must not rewrite Yukizi's own number.
    if (integration.inventoryDirection === IntegrationSyncDirection.EXPORT_ONLY) {
      await this.markSkipped(event.id, 'CHANNEL_IS_EXPORT_ONLY');
      return 'SKIPPED';
    }
    if (!integration.syncEnabled || !integration.syncInventory) {
      await this.markSkipped(event.id, 'SYNC_DISABLED');
      return 'SKIPPED';
    }
    if (mapping.inventoryConflictAt) {
      // The seller is being asked which side is right; do not pre-empt them.
      await this.markSkipped(event.id, 'UNRESOLVED_CONFLICT');
      return 'SKIPPED';
    }

    const currentQuantity = await this.inventory.getTotalStock(
      mapping.sellerOfferId,
    );
    const newQuantity = event.newQuantity;

    // Record what the channel now holds regardless — it keeps the echo check
    // and the next comparison honest.
    await this.prisma.integrationProductMapping.update({
      where: { id: mapping.id },
      data: {
        externalQuantity: newQuantity,
        externalQuantityAt: new Date(),
        lastSyncedAt: new Date(),
      },
    });

    if (currentQuantity === newQuantity) {
      // Yukizi already agrees. Nothing to apply and nothing to fan out —
      // this is where a would-be loop dies quietly.
      await this.prisma.inventoryEvent.update({
        where: { id: event.id },
        data: {
          oldQuantity: currentQuantity,
          quantityDelta: 0,
          skipReason: 'QUANTITY_UNCHANGED',
        },
      });
      return 'SKIPPED';
    }

    // Apply to Yukizi through the same path the seller portal uses.
    await this.inventory.updateDefaultBatch(mapping.sellerOfferId, newQuantity);

    await this.prisma.inventoryEvent.update({
      where: { id: event.id },
      data: {
        oldQuantity: currentQuantity,
        quantityDelta: newQuantity - currentQuantity,
      },
    });

    await this.integrations.log(event.sellerId, integration.id, {
      action: 'INVENTORY_UPDATED',
      status: IntegrationLogStatus.SUCCESS,
      entityRef: mapping.externalSku ?? undefined,
      message: `Inventory updated ${currentQuantity} → ${newQuantity}.`,
    });

    await this.fanOut(
      event.sellerId,
      mapping.sellerOfferId,
      integration.id,
      newQuantity,
    );

    return 'APPLIED';
  }

  /**
   * Queues a push for every OTHER channel carrying this listing.
   *
   * Jobs, not direct calls: writing to three platforms inside an event loop
   * would make one slow channel hold up everything else, and the runner
   * already has retry and backoff.
   */
  private async fanOut(
    sellerId: string,
    sellerOfferId: string,
    /** Null when the change originated in Yukizi, so nothing is excluded. */
    sourceIntegrationId: string | null,
    quantity: number,
  ): Promise<number> {
    const targets = await this.push.findFanOutTargets(
      sellerId,
      sellerOfferId,
      sourceIntegrationId,
    );
    if (targets.length === 0) return 0;

    // One job per channel, carrying the mappings it owns.
    const byIntegration = new Map<string, string[]>();
    for (const target of targets) {
      const bucket = byIntegration.get(target.integrationId);
      if (bucket) bucket.push(target.mappingId);
      else byIntegration.set(target.integrationId, [target.mappingId]);
    }

    for (const [integrationId, mappingIds] of byIntegration) {
      await this.prisma.integrationSyncJob.create({
        data: {
          sellerId,
          integrationId,
          jobType: SyncJobType.INVENTORY_PUSH,
          status: SyncJobStatus.PENDING,
          payload: {
            targets: mappingIds.map((mappingId) => ({ mappingId, quantity })),
          },
          totalItems: mappingIds.length,
        },
      });
    }

    return targets.length;
  }

  private async markSkipped(eventId: string, reason: string): Promise<void> {
    await this.prisma.inventoryEvent.update({
      where: { id: eventId },
      data: { status: InventoryEventStatus.SKIPPED, skipReason: reason },
    });
  }

  /**
   * Fan-out for a change made inside Yukizi (seller edits stock, an order is
   * placed). Called by the reconciliation sweep; wired here so there is one
   * definition of "which channels need telling".
   */
  async fanOutYukiziChange(
    sellerId: string,
    sellerOfferId: string,
    quantity: number,
  ): Promise<number> {
    // No source channel to exclude: the change came from Yukizi itself, so
    // every eligible channel should hear about it.
    return this.fanOut(sellerId, sellerOfferId, null, quantity);
  }
}
