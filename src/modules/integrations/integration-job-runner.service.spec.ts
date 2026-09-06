import {
  IntegrationProvider,
  IntegrationStatus,
  SyncJobStatus,
  SyncJobType,
} from '@prisma/client';
import { IntegrationJobRunnerService } from './integration-job-runner.service';
import { PermanentIntegrationError } from './integration-import.service';

const job = (over: Record<string, unknown> = {}) => ({
  id: 'job-1',
  sellerId: 'seller-1',
  integrationId: 'int-1',
  jobType: SyncJobType.INITIAL_IMPORT,
  status: SyncJobStatus.PROCESSING,
  payload: null,
  attempts: 1,
  maxAttempts: 5,
  processedItems: 0,
  ...over,
});

const integrationRow = (over: Record<string, unknown> = {}) => ({
  id: 'int-1',
  sellerId: 'seller-1',
  provider: IntegrationProvider.SHOPIFY,
  status: IntegrationStatus.CONNECTED,
  syncEnabled: true,
  syncInventory: true,
  ...over,
});

const build = () => {
  const prisma = {
    integrationSyncJob: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn(),
      update: jest.fn(),
      create: jest.fn(),
    },
    sellerIntegration: {
      findUnique: jest.fn().mockResolvedValue(integrationRow()),
      update: jest.fn(),
    },
    $transaction: jest.fn(async (ops: unknown[]) => ops),
  };
  const integrations = { log: jest.fn(), markActionRequired: jest.fn() };
  const importService = {
    importCatalogue: jest.fn().mockResolvedValue({
      imported: 3,
      matched: 2,
      conflicts: 1,
      unmapped: 0,
      nextCursor: null,
    }),
    importInventory: jest
      .fn()
      .mockResolvedValue({ applied: 1, conflicts: 0, skipped: 0 }),
  };

  const pushService = {
    pushQuantities: jest.fn().mockResolvedValue({ pushed: 0, skipped: 0 }),
  };
  const webhookRegistration = {
    registerAll: jest.fn().mockResolvedValue({ registered: 2, failed: 0 }),
  };

  const service = new IntegrationJobRunnerService(
    prisma as never,
    integrations as never,
    importService as never,
    pushService as never,
    webhookRegistration as never,
  );
  return {
    service,
    prisma,
    integrations,
    importService,
    pushService,
    webhookRegistration,
  };
};

describe('IntegrationJobRunnerService — claiming', () => {
  beforeEach(() => jest.clearAllMocks());

  it('claims a job with a compare-and-swap so two instances cannot run it twice', async () => {
    const { service, prisma } = build();
    prisma.integrationSyncJob.findMany.mockResolvedValue([job()]);
    prisma.integrationSyncJob.findUnique.mockResolvedValue(job());

    await service.runDueJobs();

    // The update only matches while the row is still PENDING.
    expect(prisma.integrationSyncJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'job-1', status: SyncJobStatus.PENDING },
        data: expect.objectContaining({ status: SyncJobStatus.PROCESSING }),
      }),
    );
  });

  it('skips a job another instance already claimed', async () => {
    const { service, prisma, importService } = build();
    prisma.integrationSyncJob.findMany.mockResolvedValue([job()]);
    prisma.integrationSyncJob.updateMany.mockResolvedValue({ count: 0 });

    const result = await service.runDueJobs();

    expect(result.processed).toBe(0);
    expect(importService.importCatalogue).not.toHaveBeenCalled();
  });

  it('only picks up jobs that are due and not permanently failed', async () => {
    const { service, prisma } = build();

    await service.runDueJobs();

    const where = prisma.integrationSyncJob.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({
      status: SyncJobStatus.PENDING,
      permanentFailure: false,
    });
    expect(where.runAfter.lte).toBeInstanceOf(Date);
  });
});

describe('IntegrationJobRunnerService — import jobs', () => {
  beforeEach(() => jest.clearAllMocks());

  const runOne = async (ctx: ReturnType<typeof build>, over = {}) => {
    ctx.prisma.integrationSyncJob.findMany.mockResolvedValue([job(over)]);
    ctx.prisma.integrationSyncJob.findUnique.mockResolvedValue(job(over));
    await ctx.service.runDueJobs();
  };

  it('queues a continuation carrying the cursor when the catalogue has more pages', async () => {
    const ctx = build();
    ctx.importService.importCatalogue.mockResolvedValue({
      imported: 250,
      matched: 250,
      conflicts: 0,
      unmapped: 0,
      nextCursor: 'page-2',
    });

    await runOne(ctx);

    const created = ctx.prisma.integrationSyncJob.create.mock.calls[0][0].data;
    expect(created).toMatchObject({
      integrationId: 'int-1',
      jobType: SyncJobType.INITIAL_IMPORT,
      payload: { cursor: 'page-2' },
    });
  });

  it('chains an inventory pull once the catalogue finishes, when inventory sync is on', async () => {
    const ctx = build();

    await runOne(ctx);

    expect(ctx.prisma.integrationSyncJob.create.mock.calls[0][0].data).toMatchObject(
      { jobType: SyncJobType.INVENTORY_PULL },
    );
  });

  it('does not chain an inventory pull when the seller turned inventory sync off', async () => {
    const ctx = build();
    ctx.prisma.sellerIntegration.findUnique.mockResolvedValue(
      integrationRow({ syncInventory: false }),
    );

    await runOne(ctx);

    expect(ctx.prisma.integrationSyncJob.create).not.toHaveBeenCalled();
  });

  it('reports conflicts as a warning in the activity feed, not a success', async () => {
    const ctx = build();

    await runOne(ctx);

    const logCall = ctx.integrations.log.mock.calls[0][2];
    expect(logCall.status).toBe('WARNING');
    expect(logCall.message).toContain('need a decision');
  });

  it('refuses to run against a disconnected channel', async () => {
    const ctx = build();
    ctx.prisma.sellerIntegration.findUnique.mockResolvedValue(
      integrationRow({ status: IntegrationStatus.DISCONNECTED }),
    );

    await runOne(ctx);

    expect(ctx.importService.importCatalogue).not.toHaveBeenCalled();
    expect(ctx.prisma.integrationSyncJob.update.mock.calls[0][0].data).toMatchObject({
      status: SyncJobStatus.FAILED,
      permanentFailure: true,
    });
  });
});

describe('IntegrationJobRunnerService — phase 3 job types', () => {
  beforeEach(() => jest.clearAllMocks());

  const runOne = async (ctx: ReturnType<typeof build>, over = {}) => {
    ctx.prisma.integrationSyncJob.findMany.mockResolvedValue([job(over)]);
    ctx.prisma.integrationSyncJob.findUnique.mockResolvedValue(job(over));
    await ctx.service.runDueJobs();
  };

  it('pushes the quantities carried in the job payload', async () => {
    const ctx = build();
    ctx.prisma.sellerIntegration.findUnique.mockResolvedValue(
      integrationRow({ inventoryDirection: 'TWO_WAY' }),
    );

    await runOne(ctx, {
      jobType: SyncJobType.INVENTORY_PUSH,
      payload: { targets: [{ mappingId: 'map-1', quantity: 4 }] },
    });

    expect(ctx.pushService.pushQuantities).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'int-1' }),
      [{ mappingId: 'map-1', quantity: 4 }],
    );
  });

  it('refuses to push to an import-only channel, which the seller set as read-only', async () => {
    const ctx = build();
    ctx.prisma.sellerIntegration.findUnique.mockResolvedValue(
      integrationRow({ inventoryDirection: 'IMPORT_ONLY' }),
    );

    await runOne(ctx, {
      jobType: SyncJobType.INVENTORY_PUSH,
      payload: { targets: [{ mappingId: 'map-1', quantity: 4 }] },
    });

    expect(ctx.pushService.pushQuantities).not.toHaveBeenCalled();
    expect(ctx.prisma.integrationSyncJob.update.mock.calls[0][0].data).toMatchObject({
      permanentFailure: true,
    });
  });

  it('runs webhook registration instead of rejecting it as unsupported', async () => {
    const ctx = build();

    await runOne(ctx, { jobType: SyncJobType.WEBHOOK_REGISTRATION });

    expect(ctx.webhookRegistration.registerAll).toHaveBeenCalled();
    expect(ctx.prisma.integrationSyncJob.update.mock.calls[0][0].data).toMatchObject({
      status: SyncJobStatus.COMPLETED,
    });
  });
});

describe('IntegrationJobRunnerService — retries and backoff', () => {
  beforeEach(() => jest.clearAllMocks());

  const failWith = async (error: unknown, attempts = 1) => {
    const ctx = build();
    ctx.prisma.integrationSyncJob.findMany.mockResolvedValue([job({ attempts })]);
    ctx.prisma.integrationSyncJob.findUnique.mockResolvedValue(job({ attempts }));
    ctx.importService.importCatalogue.mockRejectedValue(error);
    await ctx.service.runDueJobs();
    return ctx;
  };

  it('retries a transient failure with a growing delay', async () => {
    const ctx = await failWith(new Error('socket hang up'), 2);

    const data = ctx.prisma.integrationSyncJob.update.mock.calls[0][0].data;
    expect(data.status).toBe(SyncJobStatus.PENDING);
    // attempt 2 -> 60s * 2^2 = 4 minutes out.
    const delayMs = data.runAfter.getTime() - Date.now();
    expect(delayMs).toBeGreaterThan(3 * 60_000);
    expect(delayMs).toBeLessThan(5 * 60_000);
  });

  it('retries a 429 and tells the seller it is a rate limit, not a failure', async () => {
    const ctx = await failWith({ response: { status: 429 } });

    expect(ctx.prisma.integrationSyncJob.update.mock.calls[0][0].data.status).toBe(
      SyncJobStatus.PENDING,
    );
    expect(
      ctx.prisma.sellerIntegration.update.mock.calls[0][0].data.lastError,
    ).toContain('limiting requests');
  });

  it('does NOT retry a 401 — no number of attempts fixes a revoked token', async () => {
    const ctx = await failWith({ response: { status: 401 } });

    expect(ctx.prisma.integrationSyncJob.update.mock.calls[0][0].data).toMatchObject({
      status: SyncJobStatus.FAILED,
      permanentFailure: true,
    });
    // And the seller is told to reconnect rather than left waiting.
    expect(ctx.integrations.markActionRequired).toHaveBeenCalledWith(
      'int-1',
      IntegrationStatus.EXPIRED,
      expect.stringContaining('reauthorized'),
    );
  });

  it('does not retry a 403 either', async () => {
    const ctx = await failWith({ response: { status: 403 } });

    expect(ctx.prisma.integrationSyncJob.update.mock.calls[0][0].data).toMatchObject({
      permanentFailure: true,
    });
  });

  it('treats a PermanentIntegrationError as permanent and surfaces its message', async () => {
    const ctx = await failWith(
      new PermanentIntegrationError('This connection needs to be reauthorized before importing.'),
    );

    expect(ctx.prisma.integrationSyncJob.update.mock.calls[0][0].data).toMatchObject({
      permanentFailure: true,
      lastError: 'This connection needs to be reauthorized before importing.',
    });
  });

  it('gives up once the attempt budget is spent', async () => {
    const ctx = await failWith(new Error('still broken'), 5);

    expect(ctx.prisma.integrationSyncJob.update.mock.calls[0][0].data).toMatchObject({
      status: SyncJobStatus.FAILED,
      permanentFailure: true,
    });
  });

  it('never stores a provider response body in the error, only the status', async () => {
    const ctx = await failWith({
      response: { status: 500, data: { token: 'shpat_leaked_secret' } },
    });

    const stored = JSON.stringify(
      ctx.prisma.integrationSyncJob.update.mock.calls[0][0].data,
    );
    expect(stored).not.toContain('shpat_leaked_secret');
    expect(stored).toContain('HTTP 500');
  });
});
