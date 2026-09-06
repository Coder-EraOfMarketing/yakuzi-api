import { ConfigService } from '@nestjs/config';
import {
  IntegrationProvider,
  IntegrationStatus,
  SyncJobStatus,
  SyncJobType,
} from '@prisma/client';
import { IntegrationWebhookRegistrationService } from './integration-webhook-registration.service';
import { IntegrationReconciliationService } from './integration-reconciliation.service';

const config = {
  get: jest.fn((key: string) =>
    key === 'API_PUBLIC_URL' ? 'https://yukizi.com/api' : undefined,
  ),
} as unknown as ConfigService;

const integration = (over: Record<string, unknown> = {}) =>
  ({
    id: 'int-1',
    sellerId: 'seller-1',
    provider: IntegrationProvider.SHOPIFY,
    externalAccountId: 'demo.myshopify.com',
    externalStoreUrl: 'https://demo.myshopify.com',
    encryptedCredentials: 'v1.enc',
    ...over,
  }) as never;

const buildRegistration = () => {
  const prisma = {
    integrationWebhook: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      deleteMany: jest.fn(),
    },
  };
  const encryption = {
    decrypt: jest.fn().mockReturnValue({
      accessToken: 'shpat_secret',
      consumerKey: 'ck',
      consumerSecret: 'cs',
    }),
    encrypt: jest.fn().mockReturnValue('v1.sealed'),
  };
  const integrations = { log: jest.fn() };
  const shopify = {
    registerWebhook: jest.fn().mockResolvedValue('wh-100'),
    deleteWebhook: jest.fn(),
  };
  const woocommerce = {
    registerWebhook: jest.fn().mockResolvedValue('wh-200'),
    deleteWebhook: jest.fn(),
  };

  const service = new IntegrationWebhookRegistrationService(
    prisma as never,
    config,
    encryption as never,
    integrations as never,
    shopify as never,
    woocommerce as never,
  );
  return { service, prisma, encryption, integrations, shopify, woocommerce };
};

describe('IntegrationWebhookRegistrationService', () => {
  beforeEach(() => jest.clearAllMocks());

  it('subscribes Shopify to inventory changes and to the uninstall signal', async () => {
    const { service, shopify, prisma } = buildRegistration();

    const result = await service.registerAll(integration());

    expect(shopify.registerWebhook).toHaveBeenCalledWith(
      'demo.myshopify.com',
      'shpat_secret',
      'inventory_levels/update',
      'https://yukizi.com/api/integrations/shopify/webhook',
    );
    // app/uninstalled is the only reliable signal that the token just died.
    expect(shopify.registerWebhook).toHaveBeenCalledWith(
      'demo.myshopify.com',
      'shpat_secret',
      'app/uninstalled',
      expect.any(String),
    );
    expect(prisma.integrationWebhook.create).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ registered: 2, failed: 0 });
  });

  it('generates a per-webhook secret for WooCommerce and stores it encrypted', async () => {
    const { service, woocommerce, encryption, prisma } = buildRegistration();

    await service.registerAll(
      integration({
        provider: IntegrationProvider.WOOCOMMERCE,
        externalStoreUrl: 'https://mystore.com',
      }),
    );

    // Woo lets US choose the signing secret — without storing one, every
    // delivery would be unverifiable and therefore rejected.
    const secretSent = woocommerce.registerWebhook.mock.calls[0][4];
    expect(secretSent).toEqual(expect.any(String));
    expect(encryption.encrypt).toHaveBeenCalledWith({ secret: secretSent });

    const stored = prisma.integrationWebhook.create.mock.calls[0][0].data;
    expect(stored.encryptedSecret).toBe('v1.sealed');
    // The plaintext secret never reaches a column.
    expect(JSON.stringify(stored)).not.toContain(secretSent);
  });

  it('gives each WooCommerce topic its own secret', async () => {
    const { service, woocommerce } = buildRegistration();

    await service.registerAll(
      integration({ provider: IntegrationProvider.WOOCOMMERCE }),
    );

    const first = woocommerce.registerWebhook.mock.calls[0][4];
    const second = woocommerce.registerWebhook.mock.calls[1][4];
    expect(first).not.toEqual(second);
  });

  it('removes what it registered before, so a re-run cannot leave duplicates on the store', async () => {
    const { service, prisma, shopify } = buildRegistration();
    prisma.integrationWebhook.findMany.mockResolvedValue([
      { externalId: 'old-1', topic: 'inventory_levels/update' },
    ]);

    await service.registerAll(integration());

    expect(shopify.deleteWebhook).toHaveBeenCalledWith(
      'demo.myshopify.com',
      'shpat_secret',
      'old-1',
    );
    expect(prisma.integrationWebhook.deleteMany).toHaveBeenCalled();
  });

  it('reports a partial failure as a warning rather than pretending it worked', async () => {
    const { service, integrations, shopify } = buildRegistration();
    shopify.registerWebhook
      .mockResolvedValueOnce('wh-100')
      .mockResolvedValueOnce(null);

    const result = await service.registerAll(integration());

    expect(result).toEqual({ registered: 1, failed: 1 });
    const log = integrations.log.mock.calls[0][2];
    expect(log.status).toBe('WARNING');
    expect(log.message).toContain('still sync on a schedule');
  });

  it('registers nothing for Amazon, which has no webhook path here', async () => {
    const { service, prisma } = buildRegistration();

    const result = await service.registerAll(
      integration({ provider: IntegrationProvider.AMAZON }),
    );

    // Saying zero is honest; a fake subscription would be worse.
    expect(result).toEqual({ registered: 0, failed: 0 });
    expect(prisma.integrationWebhook.create).not.toHaveBeenCalled();
  });
});

const buildReconciliation = () => {
  const prisma = {
    sellerIntegration: { findMany: jest.fn().mockResolvedValue([]) },
    integrationSyncJob: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
    },
  };
  const service = new IntegrationReconciliationService(prisma as never);
  return { service, prisma };
};

describe('IntegrationReconciliationService', () => {
  beforeEach(() => jest.clearAllMocks());

  it('only sweeps connections that are live, syncing and past setup', async () => {
    const { service, prisma } = buildReconciliation();

    await service.queueStaleConnections();

    const where = prisma.sellerIntegration.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({
      status: IntegrationStatus.CONNECTED,
      syncEnabled: true,
      syncInventory: true,
      setupCompletedAt: { not: null },
    });
    // Never synced, or not synced recently.
    expect(where.OR[0]).toEqual({ lastSuccessfulSyncAt: null });
    expect(where.OR[1].lastSuccessfulSyncAt.lt).toBeInstanceOf(Date);
  });

  it('queues a reconciliation job per stale connection', async () => {
    const { service, prisma } = buildReconciliation();
    prisma.sellerIntegration.findMany.mockResolvedValue([
      { id: 'int-1', sellerId: 'seller-1' },
      { id: 'int-2', sellerId: 'seller-2' },
    ]);

    const result = await service.queueStaleConnections();

    expect(result.queued).toBe(2);
    expect(prisma.integrationSyncJob.create.mock.calls[0][0].data).toMatchObject({
      jobType: SyncJobType.RECONCILIATION,
      integrationId: 'int-1',
    });
  });

  it('never stacks a sweep on top of work already in flight', async () => {
    const { service, prisma } = buildReconciliation();
    prisma.sellerIntegration.findMany.mockResolvedValue([
      { id: 'int-1', sellerId: 'seller-1' },
    ]);
    prisma.integrationSyncJob.findFirst.mockResolvedValue({ id: 'running' });

    const result = await service.queueStaleConnections();

    expect(result.queued).toBe(0);
    expect(prisma.integrationSyncJob.create).not.toHaveBeenCalled();
    expect(prisma.integrationSyncJob.findFirst.mock.calls[0][0].where.status).toEqual({
      in: [SyncJobStatus.PENDING, SyncJobStatus.PROCESSING],
    });
  });

  it('caps how many connections one tick queues, so a spike is spread out', async () => {
    const { service, prisma } = buildReconciliation();

    await service.queueStaleConnections();

    expect(prisma.sellerIntegration.findMany.mock.calls[0][0].take).toBe(25);
  });
});
