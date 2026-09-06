import { NotFoundException, BadRequestException } from '@nestjs/common';
import {
  IntegrationProvider,
  IntegrationStatus,
  IntegrationSyncDirection,
  InventorySourceOfTruth,
  SyncJobStatus,
} from '@prisma/client';
import { IntegrationsService } from './integrations.service';

const integrationRow = (over: Record<string, unknown> = {}) => ({
  id: 'int-1',
  sellerId: 'seller-1',
  provider: IntegrationProvider.SHOPIFY,
  status: IntegrationStatus.CONNECTED,
  externalAccountId: 'demo.myshopify.com',
  externalStoreName: 'Demo Store',
  externalStoreUrl: 'https://demo.myshopify.com',
  marketplaceId: null,
  region: null,
  encryptedCredentials: 'v1.aaa.bbb.ccc',
  credentialsKeyVersion: 1,
  scopes: ['read_products'],
  syncEnabled: true,
  syncProducts: true,
  syncInventory: true,
  syncPrices: false,
  syncOrders: false,
  inventoryDirection: IntegrationSyncDirection.IMPORT_ONLY,
  sourceOfTruth: InventorySourceOfTruth.YUKIZI,
  setupCompletedAt: new Date('2026-09-01T00:00:00.000Z'),
  lastSyncAt: null,
  lastSuccessfulSyncAt: null,
  lastError: null,
  lastErrorAt: null,
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  updatedAt: new Date('2026-09-01T00:00:00.000Z'),
  disconnectedAt: null,
  ...over,
});

const build = () => {
  const prisma = {
    sellerProfile: { findUnique: jest.fn().mockResolvedValue({ id: 'seller-1' }) },
    sellerIntegration: {
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(async ({ data }: any) => integrationRow(data)),
      updateMany: jest.fn(),
    },
    sellerOffer: { findFirst: jest.fn() },
    integrationProductMapping: {
      count: jest.fn().mockResolvedValue(0),
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
    },
    integrationSyncJob: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(async ({ data }: any) => ({ id: 'job-1', ...data })),
      updateMany: jest.fn(),
    },
    integrationWebhook: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn(),
    },
    integrationLog: {
      create: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    inventoryEvent: { findFirst: jest.fn() },
    $transaction: jest.fn(async (ops: unknown[]) => ops),
  };

  const encryption = {
    isConfigured: jest.fn().mockReturnValue(true),
    encrypt: jest.fn().mockReturnValue('v1.enc'),
    decrypt: jest.fn().mockReturnValue({ accessToken: 'shpat_secret' }),
  };
  const shopify = {
    isConfigured: jest.fn().mockReturnValue(true),
    deleteWebhook: jest.fn(),
  };
  const woocommerce = {
    isConfigured: jest.fn().mockReturnValue(true),
    deleteWebhook: jest.fn(),
  };
  const amazon = {
    isConfigured: jest.fn().mockReturnValue(true),
    forgetAccessToken: jest.fn(),
  };

  const service = new IntegrationsService(
    prisma as never,
    encryption as never,
    shopify as never,
    woocommerce as never,
    amazon as never,
  );
  return { service, prisma, encryption, shopify, amazon };
};

describe('IntegrationsService — ownership scoping', () => {
  beforeEach(() => jest.clearAllMocks());

  it('scopes every integration lookup by the seller resolved from the JWT, never a client-supplied id', async () => {
    const { service, prisma } = build();
    prisma.sellerIntegration.findFirst.mockResolvedValue(integrationRow());

    await service.requestSync('user-1', 'int-1');

    // The WHERE clause must carry BOTH the id and the seller — an id alone
    // would let seller B manage seller A's connection.
    expect(prisma.sellerIntegration.findFirst).toHaveBeenCalledWith({
      where: { id: 'int-1', sellerId: 'seller-1' },
    });
  });

  it("returns NotFound (not Forbidden) for another seller's integration, so ids cannot be enumerated", async () => {
    const { service, prisma } = build();
    prisma.sellerIntegration.findFirst.mockResolvedValue(null);

    await expect(service.disconnect('user-1', 'someone-elses-id')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('refuses to map an external listing onto a product owned by a different seller', async () => {
    const { service, prisma } = build();
    prisma.sellerIntegration.findFirst.mockResolvedValue(integrationRow());
    prisma.integrationProductMapping.findFirst.mockResolvedValue({
      id: 'map-1',
      sellerId: 'seller-1',
      integrationId: 'int-1',
      externalSku: 'EXT-1',
    });
    // The offer lookup is seller-scoped, so a rival's product id finds nothing.
    prisma.sellerOffer.findFirst.mockResolvedValue(null);

    await expect(
      service.mapProduct('user-1', 'int-1', 'map-1', 'rival-offer-id'),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(prisma.sellerOffer.findFirst).toHaveBeenCalledWith({
      where: { id: 'rival-offer-id', sellerId: 'seller-1', deletedAt: null },
      select: { id: true, sku: true, catalogProductId: true },
    });
    expect(prisma.integrationProductMapping.update).not.toHaveBeenCalled();
  });

  it('throws when the user has no seller profile at all', async () => {
    const { service, prisma } = build();
    prisma.sellerProfile.findUnique.mockResolvedValue(null);

    await expect(service.resolveSellerId('user-x')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('IntegrationsService — credential exposure', () => {
  beforeEach(() => jest.clearAllMocks());

  it('never includes credential fields in the seller-facing view', () => {
    const { service } = build();

    const view = service.toSellerView(
      integrationRow({ encryptedCredentials: 'v1.super.secret.value' }) as never,
    );

    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain('super.secret.value');
    expect(view).not.toHaveProperty('encryptedCredentials');
    expect(view).not.toHaveProperty('credentialsKeyVersion');
    // Sanity: it still carries what the UI needs.
    expect(view).toMatchObject({
      provider: IntegrationProvider.SHOPIFY,
      storeName: 'Demo Store',
      health: 'CONNECTED',
    });
  });

  it('reports an errored or expired connection as ACTION_REQUIRED so the UI offers Reconnect', () => {
    const { service } = build();

    expect(
      service.toSellerView(integrationRow({ status: IntegrationStatus.EXPIRED }) as never)
        .health,
    ).toBe('ACTION_REQUIRED');
    expect(
      service.toSellerView(integrationRow({ status: IntegrationStatus.ERROR }) as never)
        .health,
    ).toBe('ACTION_REQUIRED');
    expect(
      service.toSellerView(integrationRow({ status: IntegrationStatus.PAUSED }) as never)
        .health,
    ).toBe('PAUSED');
  });
});

describe('IntegrationsService — Sync Now', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns the running job instead of queueing a second one when clicked twice', async () => {
    const { service, prisma } = build();
    prisma.sellerIntegration.findFirst.mockResolvedValue(integrationRow());
    prisma.integrationSyncJob.findFirst.mockResolvedValue({
      id: 'job-existing',
      status: SyncJobStatus.PROCESSING,
    });

    const result = await service.requestSync('user-1', 'int-1');

    expect(result).toEqual({
      id: 'job-existing',
      status: SyncJobStatus.PROCESSING,
      alreadyQueued: true,
    });
    expect(prisma.integrationSyncJob.create).not.toHaveBeenCalled();
  });

  it('queues a job when nothing is running', async () => {
    const { service, prisma } = build();
    prisma.sellerIntegration.findFirst.mockResolvedValue(integrationRow());

    const result = await service.requestSync('user-1', 'int-1');

    expect(prisma.integrationSyncJob.create).toHaveBeenCalled();
    expect(result.alreadyQueued).toBe(false);
  });

  it('refuses to sync a connection whose credentials were rejected', async () => {
    const { service, prisma } = build();
    prisma.sellerIntegration.findFirst.mockResolvedValue(
      integrationRow({ status: IntegrationStatus.EXPIRED }),
    );

    await expect(service.requestSync('user-1', 'int-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.integrationSyncJob.create).not.toHaveBeenCalled();
  });

  it('refuses to sync before the setup wizard has been completed', async () => {
    const { service, prisma } = build();
    prisma.sellerIntegration.findFirst.mockResolvedValue(
      integrationRow({ setupCompletedAt: null }),
    );

    await expect(service.requestSync('user-1', 'int-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('IntegrationsService — disconnect', () => {
  beforeEach(() => jest.clearAllMocks());

  it('destroys the stored credential and cancels queued work, without deleting products', async () => {
    const { service, prisma } = build();
    prisma.sellerIntegration.findFirst.mockResolvedValue(integrationRow());

    await service.disconnect('user-1', 'int-1');

    const updateCall = prisma.sellerIntegration.update.mock.calls[0][0];
    expect(updateCall.data).toMatchObject({
      status: IntegrationStatus.DISCONNECTED,
      encryptedCredentials: null,
      syncEnabled: false,
      scopes: [],
    });

    // Queued jobs are stopped so nothing runs against a dead credential.
    expect(prisma.integrationSyncJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ permanentFailure: true }),
      }),
    );

    // Nothing in this flow may touch the seller's catalogue.
    expect((prisma as any).sellerOffer.findFirst).not.toHaveBeenCalled();
    expect(prisma.integrationProductMapping.update).not.toHaveBeenCalled();
  });

  it('revokes the webhooks it created on the store before dropping the credential', async () => {
    const { service, prisma, shopify } = build();
    prisma.sellerIntegration.findFirst.mockResolvedValue(integrationRow());
    prisma.integrationWebhook.findMany.mockResolvedValue([
      { id: 'w1', externalId: '99', topic: 'inventory_levels/update' },
    ]);

    await service.disconnect('user-1', 'int-1');

    expect(shopify.deleteWebhook).toHaveBeenCalledWith(
      'demo.myshopify.com',
      'shpat_secret',
      '99',
    );
  });

  it('still disconnects when the remote cleanup call fails', async () => {
    const { service, prisma, shopify } = build();
    prisma.sellerIntegration.findFirst.mockResolvedValue(integrationRow());
    prisma.integrationWebhook.findMany.mockResolvedValue([
      { id: 'w1', externalId: '99', topic: 'inventory_levels/update' },
    ]);
    shopify.deleteWebhook.mockRejectedValue(new Error('store unreachable'));

    await expect(service.disconnect('user-1', 'int-1')).resolves.toEqual({
      disconnected: true,
    });
    expect(prisma.sellerIntegration.update).toHaveBeenCalled();
  });
});

describe('IntegrationsService — sync settings', () => {
  beforeEach(() => jest.clearAllMocks());

  it('allows two-way sync on Shopify, which has a verified inbound webhook path', async () => {
    const { service, prisma } = build();
    prisma.sellerIntegration.findFirst.mockResolvedValue(integrationRow());

    await service.updateSettings('user-1', 'int-1', {
      inventoryDirection: IntegrationSyncDirection.TWO_WAY,
    });

    expect(prisma.sellerIntegration.update.mock.calls[0][0].data).toMatchObject({
      inventoryDirection: IntegrationSyncDirection.TWO_WAY,
    });
  });

  it('allows two-way sync on WooCommerce', async () => {
    const { service, prisma } = build();
    prisma.sellerIntegration.findFirst.mockResolvedValue(
      integrationRow({ provider: IntegrationProvider.WOOCOMMERCE }),
    );

    await service.updateSettings('user-1', 'int-1', {
      inventoryDirection: IntegrationSyncDirection.TWO_WAY,
    });

    expect(prisma.sellerIntegration.update).toHaveBeenCalled();
  });

  it('still refuses two-way sync on Amazon, whose only inbound path is the periodic sweep', async () => {
    const { service, prisma } = build();
    prisma.sellerIntegration.findFirst.mockResolvedValue(
      integrationRow({ provider: IntegrationProvider.AMAZON }),
    );

    // A sweep cannot tell an echo from a real change, so two-way there would
    // risk double-deduction.
    await expect(
      service.updateSettings('user-1', 'int-1', {
        inventoryDirection: IntegrationSyncDirection.TWO_WAY,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.sellerIntegration.update).not.toHaveBeenCalled();
  });

  it('moves a connection to PAUSED when the seller turns sync off, and back on resume', async () => {
    const { service, prisma } = build();
    prisma.sellerIntegration.findFirst.mockResolvedValue(integrationRow());

    await service.updateSettings('user-1', 'int-1', { syncEnabled: false });
    expect(prisma.sellerIntegration.update.mock.calls[0][0].data).toMatchObject({
      syncEnabled: false,
      status: IntegrationStatus.PAUSED,
    });

    jest.clearAllMocks();
    prisma.sellerIntegration.findFirst.mockResolvedValue(
      integrationRow({ status: IntegrationStatus.PAUSED }),
    );
    await service.updateSettings('user-1', 'int-1', { syncEnabled: true });
    expect(prisma.sellerIntegration.update.mock.calls[0][0].data).toMatchObject({
      syncEnabled: true,
      status: IntegrationStatus.CONNECTED,
    });
  });
});
