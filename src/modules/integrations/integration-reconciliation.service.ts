import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  IntegrationStatus,
  SyncJobStatus,
  SyncJobType,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

/**
 * Periodic drift correction.
 *
 * Webhooks fail. They get throttled, blocked by a security plugin, dropped
 * during a deploy, or never subscribed at all — Amazon has no webhook path
 * here and relies on this entirely. Without a sweep, a missed notification
 * means a channel quietly holds the wrong quantity forever, which is exactly
 * the failure sellers notice as oversells.
 *
 * The sweep only ENQUEUES work; the job runner does the talking, so this
 * inherits its rate limiting, retries and backoff for free.
 */
@Injectable()
export class IntegrationReconciliationService {
  private readonly logger = new Logger(IntegrationReconciliationService.name);

  /** How stale a connection must be before it is swept again. */
  private static readonly STALE_AFTER_MS = 6 * 60 * 60 * 1000;
  /** Connections queued per tick, so a spike of sellers is spread out. */
  private static readonly MAX_PER_TICK = 25;

  private running = false;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Hourly, not every minute: a sweep is a full catalogue read per channel,
   * and doing it more often would burn a seller's API quota for no benefit.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async handleCron(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const { queued } = await this.queueStaleConnections();
      if (queued > 0) {
        this.logger.log(`Queued reconciliation for ${queued} connection(s)`);
      }
    } catch (error) {
      this.logger.error(
        `Reconciliation sweep failed: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    } finally {
      this.running = false;
    }
  }

  /** Public so tests and an admin trigger can drive it directly. */
  async queueStaleConnections(): Promise<{ queued: number }> {
    const staleBefore = new Date(
      Date.now() - IntegrationReconciliationService.STALE_AFTER_MS,
    );

    const candidates = await this.prisma.sellerIntegration.findMany({
      where: {
        status: IntegrationStatus.CONNECTED,
        syncEnabled: true,
        syncInventory: true,
        // Setup incomplete means the seller has not chosen what to sync yet.
        setupCompletedAt: { not: null },
        OR: [
          { lastSuccessfulSyncAt: null },
          { lastSuccessfulSyncAt: { lt: staleBefore } },
        ],
      },
      orderBy: { lastSuccessfulSyncAt: { sort: 'asc', nulls: 'first' } },
      take: IntegrationReconciliationService.MAX_PER_TICK,
      select: { id: true, sellerId: true },
    });

    let queued = 0;
    for (const integration of candidates) {
      // Never stack a sweep on top of work already in flight — that would
      // double the API calls for no extra freshness.
      const active = await this.prisma.integrationSyncJob.findFirst({
        where: {
          integrationId: integration.id,
          status: { in: [SyncJobStatus.PENDING, SyncJobStatus.PROCESSING] },
        },
        select: { id: true },
      });
      if (active) continue;

      await this.prisma.integrationSyncJob.create({
        data: {
          sellerId: integration.sellerId,
          integrationId: integration.id,
          jobType: SyncJobType.RECONCILIATION,
        },
      });
      queued += 1;
    }

    return { queued };
  }
}
