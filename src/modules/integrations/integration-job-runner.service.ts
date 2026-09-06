import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AxiosError } from 'axios';
import {
  IntegrationLogStatus,
  IntegrationStatus,
  IntegrationSyncDirection,
  IntegrationSyncJob,
  SellerIntegration,
  SyncJobStatus,
  SyncJobType,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { IntegrationsService } from './integrations.service';
import {
  IntegrationImportService,
  PermanentIntegrationError,
} from './integration-import.service';
import { IntegrationPushService } from './integration-push.service';
import { IntegrationWebhookRegistrationService } from './integration-webhook-registration.service';

/**
 * Runs queued channel work.
 *
 * Uses the repo's existing background pattern (@Cron on an injectable service,
 * as CheckoutAbandonmentSweepService does) rather than a queue runtime — bullmq
 * is declared in package.json but used nowhere in this codebase, and adding a
 * worker process would be a deployment change nobody asked for.
 *
 * Jobs are claimed with a compare-and-swap so two API instances cannot run the
 * same job twice.
 */
@Injectable()
export class IntegrationJobRunnerService {
  private readonly logger = new Logger(IntegrationJobRunnerService.name);

  /** Jobs per tick. Keeps one busy seller from starving everyone else. */
  private static readonly JOBS_PER_TICK = 5;
  /** Backoff: 1m, 4m, 9m, 16m, 25m — quadratic, capped. */
  private static readonly BACKOFF_BASE_MS = 60_000;
  private static readonly BACKOFF_CAP_MS = 30 * 60_000;

  /** Guards against a slow tick overlapping the next one in-process. */
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly integrations: IntegrationsService,
    private readonly importService: IntegrationImportService,
    private readonly pushService: IntegrationPushService,
    private readonly webhookRegistration: IntegrationWebhookRegistrationService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async handleCron(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.runDueJobs();
    } catch (error) {
      this.logger.error(
        `Integration job tick failed: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    } finally {
      this.running = false;
    }
  }

  /** Public so tests and a future admin trigger can drive it directly. */
  async runDueJobs(): Promise<{ processed: number }> {
    const candidates = await this.prisma.integrationSyncJob.findMany({
      where: {
        status: SyncJobStatus.PENDING,
        runAfter: { lte: new Date() },
        permanentFailure: false,
      },
      orderBy: { createdAt: 'asc' },
      take: IntegrationJobRunnerService.JOBS_PER_TICK,
    });

    let processed = 0;
    for (const candidate of candidates) {
      const claimed = await this.claim(candidate.id);
      if (!claimed) continue; // Another instance got there first.
      await this.runJob(claimed);
      processed += 1;
    }
    return { processed };
  }

  /**
   * Compare-and-swap claim: the update only matches while the row is still
   * PENDING, so exactly one instance can transition it to PROCESSING.
   */
  private async claim(jobId: string): Promise<IntegrationSyncJob | null> {
    const result = await this.prisma.integrationSyncJob.updateMany({
      where: { id: jobId, status: SyncJobStatus.PENDING },
      data: {
        status: SyncJobStatus.PROCESSING,
        startedAt: new Date(),
        attempts: { increment: 1 },
      },
    });
    if (result.count !== 1) return null;
    return this.prisma.integrationSyncJob.findUnique({ where: { id: jobId } });
  }

  private async runJob(job: IntegrationSyncJob): Promise<void> {
    const integration = await this.prisma.sellerIntegration.findUnique({
      where: { id: job.integrationId },
    });

    if (!integration || integration.status === IntegrationStatus.DISCONNECTED) {
      await this.finishPermanently(job, 'The channel is no longer connected.');
      return;
    }
    if (!integration.syncEnabled) {
      await this.finishPermanently(job, 'Syncing is turned off for this channel.');
      return;
    }

    try {
      switch (job.jobType) {
        case SyncJobType.INITIAL_IMPORT:
        case SyncJobType.RECONCILIATION:
          await this.runImport(job, integration);
          break;

        case SyncJobType.INVENTORY_PULL:
          await this.runInventoryPull(job, integration);
          break;

        case SyncJobType.INVENTORY_PUSH:
          await this.runInventoryPush(job, integration);
          break;

        case SyncJobType.WEBHOOK_REGISTRATION:
          await this.runWebhookRegistration(job, integration);
          break;

        default:
          await this.finishPermanently(
            job,
            'This job type is not supported yet.',
          );
          return;
      }
    } catch (error) {
      await this.handleFailure(job, integration, error);
    }
  }

  /**
   * Catalogue import. A catalogue larger than one run's page budget is
   * continued by re-queueing with the cursor, so a 10,000-product store makes
   * steady progress instead of timing out.
   */
  private async runImport(
    job: IntegrationSyncJob,
    integration: SellerIntegration,
  ): Promise<void> {
    const payload = (job.payload ?? {}) as { cursor?: string | null };

    const result = await this.importService.importCatalogue(
      integration,
      payload.cursor ?? null,
    );

    const processedSoFar = job.processedItems + result.imported;

    if (result.nextCursor) {
      // More pages remain: finish this job and queue the continuation.
      await this.prisma.$transaction([
        this.prisma.integrationSyncJob.update({
          where: { id: job.id },
          data: {
            status: SyncJobStatus.COMPLETED,
            completedAt: new Date(),
            processedItems: processedSoFar,
          },
        }),
        this.prisma.integrationSyncJob.create({
          data: {
            sellerId: job.sellerId,
            integrationId: job.integrationId,
            jobType: job.jobType,
            payload: { cursor: result.nextCursor },
            processedItems: processedSoFar,
            // A short pause between chunks keeps us well under rate limits.
            runAfter: new Date(Date.now() + 5_000),
          },
        }),
      ]);
      return;
    }

    // Catalogue finished. Inventory import follows only if the seller enabled
    // it — otherwise mapping alone is what they asked for.
    if (integration.syncInventory) {
      await this.prisma.integrationSyncJob.create({
        data: {
          sellerId: job.sellerId,
          integrationId: job.integrationId,
          jobType: SyncJobType.INVENTORY_PULL,
          runAfter: new Date(Date.now() + 2_000),
        },
      });
    }

    await this.completeJob(job, integration, processedSoFar);

    await this.integrations.log(integration.sellerId, integration.id, {
      action: 'PRODUCTS_IMPORTED',
      status:
        result.conflicts > 0
          ? IntegrationLogStatus.WARNING
          : IntegrationLogStatus.SUCCESS,
      message: this.describeImport(result),
    });
  }

  /** Seller-readable one-liner for the activity feed. */
  private describeImport(result: {
    imported: number;
    matched: number;
    conflicts: number;
    unmapped: number;
  }): string {
    const parts = [`${result.imported} listings imported`];
    if (result.matched) parts.push(`${result.matched} matched by SKU`);
    if (result.conflicts) parts.push(`${result.conflicts} need a decision`);
    if (result.unmapped) parts.push(`${result.unmapped} not matched`);
    return `${parts.join(', ')}.`;
  }

  /**
   * Writes Yukizi quantities out to one channel.
   *
   * Refuses on an import-only channel even if a job somehow reached here:
   * the seller has said that channel is a read source, and writing to it
   * would be doing the opposite of what they configured.
   */
  private async runInventoryPush(
    job: IntegrationSyncJob,
    integration: SellerIntegration,
  ): Promise<void> {
    if (integration.inventoryDirection === IntegrationSyncDirection.IMPORT_ONLY) {
      await this.finishPermanently(
        job,
        'This channel is set to import only, so Yukizi does not write to it.',
      );
      return;
    }

    const payload = (job.payload ?? {}) as {
      targets?: Array<{ mappingId: string; quantity: number }>;
    };
    const targets = payload.targets ?? [];

    const result = await this.pushService.pushQuantities(integration, targets);
    await this.completeJob(job, integration, result.pushed);
  }

  /** Subscribes to the channel's change notifications. */
  private async runWebhookRegistration(
    job: IntegrationSyncJob,
    integration: SellerIntegration,
  ): Promise<void> {
    const result = await this.webhookRegistration.registerAll(integration);
    await this.completeJob(job, integration, result.registered);
  }

  private async runInventoryPull(
    job: IntegrationSyncJob,
    integration: SellerIntegration,
  ): Promise<void> {
    const result = await this.importService.importInventory(integration);
    await this.completeJob(job, integration, result.applied);

    await this.integrations.log(integration.sellerId, integration.id, {
      action: 'INVENTORY_IMPORTED',
      status:
        result.conflicts > 0
          ? IntegrationLogStatus.WARNING
          : IntegrationLogStatus.SUCCESS,
      message:
        result.conflicts > 0
          ? `${result.applied} quantities updated, ${result.conflicts} differences need your decision.`
          : `${result.applied} quantities updated.`,
    });
  }

  private async completeJob(
    job: IntegrationSyncJob,
    integration: SellerIntegration,
    processedItems: number,
  ): Promise<void> {
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.integrationSyncJob.update({
        where: { id: job.id },
        data: {
          status: SyncJobStatus.COMPLETED,
          completedAt: now,
          processedItems,
          lastError: null,
        },
      }),
      this.prisma.sellerIntegration.update({
        where: { id: integration.id },
        data: {
          lastSyncAt: now,
          lastSuccessfulSyncAt: now,
          lastError: null,
          lastErrorAt: null,
        },
      }),
    ]);
  }

  /**
   * Decides whether a failure is worth retrying.
   *
   * Retried: timeouts, 5xx, and 429 (the channel is throttling us, which is
   * exactly what backoff is for).
   * Not retried: 401/403 and undecryptable credentials — no number of attempts
   * fixes a revoked token, and hammering it looks like an attack.
   */
  private async handleFailure(
    job: IntegrationSyncJob,
    integration: SellerIntegration,
    error: unknown,
  ): Promise<void> {
    const status = (error as AxiosError)?.response?.status;
    const permanent =
      error instanceof PermanentIntegrationError ||
      status === 401 ||
      status === 403;

    if (permanent) {
      const message =
        error instanceof PermanentIntegrationError
          ? error.message
          : 'This connection needs to be reauthorized.';
      await this.finishPermanently(job, message);
      await this.integrations.markActionRequired(
        integration.id,
        IntegrationStatus.EXPIRED,
        message,
      );
      await this.integrations.log(integration.sellerId, integration.id, {
        action: 'SYNC_FAILED',
        status: IntegrationLogStatus.FAILURE,
        message,
      });
      return;
    }

    const attempts = job.attempts;
    const exhausted = attempts >= job.maxAttempts;

    const sellerMessage =
      status === 429
        ? 'Sync is temporarily delayed because the connected platform is limiting requests. Yukizi will retry automatically.'
        : 'Some updates could not be synchronized. Yukizi will retry automatically.';

    if (exhausted) {
      await this.finishPermanently(
        job,
        'Sync did not succeed after several attempts.',
      );
      await this.integrations.log(integration.sellerId, integration.id, {
        action: 'SYNC_FAILED',
        status: IntegrationLogStatus.FAILURE,
        message: 'Sync did not succeed after several attempts.',
      });
      await this.prisma.sellerIntegration.update({
        where: { id: integration.id },
        data: {
          lastError: 'Some updates could not be synchronized.',
          lastErrorAt: new Date(),
        },
      });
      return;
    }

    const backoff = Math.min(
      IntegrationJobRunnerService.BACKOFF_CAP_MS,
      IntegrationJobRunnerService.BACKOFF_BASE_MS * attempts * attempts,
    );

    await this.prisma.integrationSyncJob.update({
      where: { id: job.id },
      data: {
        status: SyncJobStatus.PENDING,
        runAfter: new Date(Date.now() + backoff),
        lastError: this.sanitize(error),
      },
    });

    this.logger.warn(
      `Integration job ${job.id} failed (attempt ${attempts}/${job.maxAttempts}), retrying in ${Math.round(
        backoff / 1000,
      )}s`,
    );

    await this.prisma.sellerIntegration.update({
      where: { id: integration.id },
      data: { lastError: sellerMessage, lastErrorAt: new Date() },
    });
  }

  private async finishPermanently(
    job: IntegrationSyncJob,
    reason: string,
  ): Promise<void> {
    await this.prisma.integrationSyncJob.update({
      where: { id: job.id },
      data: {
        status: SyncJobStatus.FAILED,
        permanentFailure: true,
        completedAt: new Date(),
        lastError: reason,
      },
    });
  }

  /**
   * Error text safe to persist. Provider responses can echo request headers,
   * so only the status line and message are kept — never a body.
   */
  private sanitize(error: unknown): string {
    const status = (error as AxiosError)?.response?.status;
    if (status) return `Channel responded with HTTP ${status}`;
    if (error instanceof Error) return error.message.slice(0, 300);
    return 'Unknown error';
  }
}
