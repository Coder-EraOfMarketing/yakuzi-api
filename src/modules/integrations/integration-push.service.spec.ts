import {
  FulfillmentChannel,
  IntegrationMappingStatus,
  IntegrationProvider,
  IntegrationStatus,
  IntegrationSyncDirection,
  InventoryEventStatus,
} from '@prisma/client';
import { IntegrationPushService } from './integration-push.service';
import { PermanentIntegrationError } from './integration-import.service';

const integration = (over: Record<string, unknown> = {}) =>
  ({
    id: 'int-1',
    sellerId: 'seller-1',
    provider: IntegrationProvider.SHOPIFY,
    status: IntegrationStatus.CONNECTED,
    externalAccountId: 'demo.myshopify.com',
    externalStoreUrl: 'https://demo.myshopify.com',
    marketplaceId: null,
    region: null,
    encryptedCredentials: 'v1.enc',
    ...over,
  }) as never;

const mapping = (over: Record<string, unknown> = {}) => ({
  id: 'map-1',
  integrationId: 'int-1',
  sellerOfferId: 'offer-1',
  status: IntegrationMappingStatus.MAPPED,
  fulfillmentChannel: FulfillmentChannel.MERCHANT,
  inventoryConflictAt: null,
  externalQuantity: 12,
  externalProductId: 'p1',
  externalVariantId: 'v1',
  externalSku: 'YK-1',
  externalInventoryRef: 'inv-99',
  externalProductType: 'PRODUCT',
  ...over,
});

const build = () => {
  const prisma = {
    integrationProductMapping: {
      findUnique: jest.fn(async () => mapping()),
      findMany: jest.fn(async (_args?: any) => []),
      update: jest.fn(),
    },
    inventoryEvent: {
      create: jest.fn(async ({ data }: any) => ({ id: 'evt-1', ...data })),
      update: jest.fn(),
    },
    $transaction: jest.fn(async (ops: unknown[]) => ops),
  };
  const encryption = {
    decrypt: jest.fn().mockReturnValue({
      accessToken: 'shpat_secret',
      consumerKey: 'ck',
      consumerSecret: 'cs',
      refreshToken: 'Atzr|r',
      sellingPartnerId: 'A1',
    }),
  };
  const integrations = { log: jest.fn() };
  const shopify = {
    fetchPrimaryLocationId: jest.fn().mockResolvedValue('loc-1'),
    setInventoryLevel: jest.fn(),
  };
  const woocommerce = { updateStockQuantity: jest.fn() };
  const amazon = { setMerchantQuantity: jest.fn() };

  const service = new IntegrationPushService(
    prisma as never,
    encryption as never,
    integrations as never,
    shopify as never,
    woocommerce as never,
    amazon as never,
  );
  // The inter-write pause is not what these tests are about.
  jest
    .spyOn(IntegrationPushService.prototype as never, 'delay')
    .mockResolvedValue(undefined as never);

  return { service, prisma, encryption, integrations, shopify, woocommerce, amazon };
};

describe('IntegrationPushService — loop prevention', () => {
  beforeEach(() => jest.clearAllMocks());

  it('records our intended quantity BEFORE calling the channel, so the echo is recognisable', async () => {
    const { service, prisma, shopify } = build();

    await service.pushQuantities(integration(), [
      { mappingId: 'map-1', quantity: 7 },
    ]);

    // Ordering matters: if the request succeeds but the response is lost, the
    // echo must still be recognised.
    const eventCreatedAt = prisma.inventoryEvent.create.mock.invocationCallOrder[0];
    const channelCalledAt = shopify.setInventoryLevel.mock.invocationCallOrder[0];
    expect(eventCreatedAt).toBeLessThan(channelCalledAt);

    const event = prisma.inventoryEvent.create.mock.calls[0][0].data;
    expect(event).toMatchObject({
      sourcePlatform: 'YUKIZI',
      newQuantity: 7,
      oldQuantity: 12,
      quantityDelta: -5,
      status: InventoryEventStatus.PENDING,
    });
    // The idempotency key is what the echo check keys off.
    expect(event.idempotencyKey).toEqual(expect.any(String));
    // No provider event id: this is our own write, not a delivery.
    expect(event.sourceEventId).toBeNull();
  });

  it('records the new channel quantity so the next echo comparison has the right baseline', async () => {
    const { service, prisma } = build();

    await service.pushQuantities(integration(), [
      { mappingId: 'map-1', quantity: 7 },
    ]);

    const updates = prisma.$transaction.mock.calls[0][0];
    expect(updates).toHaveLength(2);
    expect(prisma.integrationProductMapping.update.mock.calls[0][0].data).toMatchObject(
      { externalQuantity: 7 },
    );
  });

  it('does not write when the channel already holds that quantity', async () => {
    const { service, prisma, shopify } = build();

    const result = await service.pushQuantities(integration(), [
      { mappingId: 'map-1', quantity: 12 }, // already 12
    ]);

    expect(result).toEqual({ pushed: 0, skipped: 1 });
    expect(shopify.setInventoryLevel).not.toHaveBeenCalled();
    expect(prisma.inventoryEvent.create).not.toHaveBeenCalled();
  });
});

describe('IntegrationPushService — what it refuses to write', () => {
  beforeEach(() => jest.clearAllMocks());

  it('never writes Amazon FBA stock', async () => {
    const { service, prisma, shopify } = build();
    prisma.integrationProductMapping.findUnique.mockResolvedValue(
      mapping({ fulfillmentChannel: FulfillmentChannel.AMAZON_FBA }),
    );

    const result = await service.pushQuantities(integration(), [
      { mappingId: 'map-1', quantity: 7 },
    ]);

    expect(result.skipped).toBe(1);
    expect(shopify.setInventoryLevel).not.toHaveBeenCalled();
  });

  it('never writes while an inventory difference is unresolved', async () => {
    const { service, prisma, shopify } = build();
    prisma.integrationProductMapping.findUnique.mockResolvedValue(
      mapping({ inventoryConflictAt: new Date() }),
    );

    const result = await service.pushQuantities(integration(), [
      { mappingId: 'map-1', quantity: 7 },
    ]);

    // The seller is being asked which number is right; do not pre-empt them.
    expect(result.skipped).toBe(1);
    expect(shopify.setInventoryLevel).not.toHaveBeenCalled();
  });

  it('never writes to a mapping belonging to a different integration', async () => {
    const { service, prisma, shopify } = build();
    prisma.integrationProductMapping.findUnique.mockResolvedValue(
      mapping({ integrationId: 'someone-else' }),
    );

    const result = await service.pushQuantities(integration(), [
      { mappingId: 'map-1', quantity: 7 },
    ]);

    expect(result.skipped).toBe(1);
    expect(shopify.setInventoryLevel).not.toHaveBeenCalled();
  });

  it('never writes to an unmapped row', async () => {
    const { service, prisma, shopify } = build();
    prisma.integrationProductMapping.findUnique.mockResolvedValue(
      mapping({ status: IntegrationMappingStatus.UNMAPPED }),
    );

    await service.pushQuantities(integration(), [
      { mappingId: 'map-1', quantity: 7 },
    ]);

    expect(shopify.setInventoryLevel).not.toHaveBeenCalled();
  });
});

describe('IntegrationPushService — per-provider writes', () => {
  beforeEach(() => jest.clearAllMocks());

  it('sets an absolute Shopify quantity against the resolved location', async () => {
    const { service, shopify } = build();

    await service.pushQuantities(integration(), [
      { mappingId: 'map-1', quantity: 7 },
    ]);

    expect(shopify.setInventoryLevel).toHaveBeenCalledWith(
      'demo.myshopify.com',
      'shpat_secret',
      'inv-99',
      'loc-1',
      7,
    );
  });

  it('fails permanently when the Shopify store has no location to write to', async () => {
    const { service, shopify } = build();
    shopify.fetchPrimaryLocationId.mockResolvedValue(null);

    await expect(
      service.pushQuantities(integration(), [{ mappingId: 'map-1', quantity: 7 }]),
    ).rejects.toBeInstanceOf(PermanentIntegrationError);
  });

  it('updates a WooCommerce variation through its own endpoint', async () => {
    const { service, woocommerce } = build();

    await service.pushQuantities(
      integration({ provider: IntegrationProvider.WOOCOMMERCE }),
      [{ mappingId: 'map-1', quantity: 7 }],
    );

    expect(woocommerce.updateStockQuantity).toHaveBeenCalledWith(
      'https://demo.myshopify.com',
      { consumerKey: 'ck', consumerSecret: 'cs' },
      'p1',
      'v1',
      7,
    );
  });

  it('treats an empty variant id as a simple WooCommerce product', async () => {
    const { service, prisma, woocommerce } = build();
    prisma.integrationProductMapping.findUnique.mockResolvedValue(
      mapping({ externalVariantId: '' }),
    );

    await service.pushQuantities(
      integration({ provider: IntegrationProvider.WOOCOMMERCE }),
      [{ mappingId: 'map-1', quantity: 7 }],
    );

    expect(woocommerce.updateStockQuantity.mock.calls[0][3]).toBeNull();
  });

  it('patches Amazon by SKU and product type', async () => {
    const { service, amazon } = build();

    await service.pushQuantities(
      integration({
        provider: IntegrationProvider.AMAZON,
        marketplaceId: 'A21TJRUUN4KGV',
        region: 'eu',
      }),
      [{ mappingId: 'map-1', quantity: 7 }],
    );

    expect(amazon.setMerchantQuantity).toHaveBeenCalledWith(
      expect.objectContaining({ marketplaceId: 'A21TJRUUN4KGV', region: 'eu' }),
      'YK-1',
      'PRODUCT',
      7,
    );
  });

  it('refuses an Amazon write when the product type was never captured', async () => {
    const { service, prisma, amazon } = build();
    prisma.integrationProductMapping.findUnique.mockResolvedValue(
      mapping({ externalProductType: null }),
    );

    const result = await service.pushQuantities(
      integration({ provider: IntegrationProvider.AMAZON }),
      [{ mappingId: 'map-1', quantity: 7 }],
    );

    // One incomplete listing must not abort the batch — it is skipped with the
    // reason recorded against that row.
    expect(amazon.setMerchantQuantity).not.toHaveBeenCalled();
    expect(result).toEqual({ pushed: 0, skipped: 1 });
    expect(prisma.integrationProductMapping.update.mock.calls[0][0].data.lastError)
      .toContain('product type');
  });

  it('skips only the un-addressable row and still writes the others in the batch', async () => {
    const { service, prisma, shopify } = build();
    prisma.integrationProductMapping.findUnique
      .mockResolvedValueOnce(mapping({ id: 'map-1', externalInventoryRef: null }))
      .mockResolvedValueOnce(mapping({ id: 'map-2' }));

    const result = await service.pushQuantities(integration(), [
      { mappingId: 'map-1', quantity: 7 },
      { mappingId: 'map-2', quantity: 7 },
    ]);

    expect(result).toEqual({ pushed: 1, skipped: 1 });
    expect(shopify.setInventoryLevel).toHaveBeenCalledTimes(1);
  });
});

describe('IntegrationPushService — failures', () => {
  beforeEach(() => jest.clearAllMocks());

  it('marks the outbound event FAILED and keeps going for a single bad row', async () => {
    const { service, prisma, shopify } = build();
    shopify.setInventoryLevel.mockRejectedValue({ response: { status: 422 } });

    const result = await service.pushQuantities(integration(), [
      { mappingId: 'map-1', quantity: 7 },
    ]);

    expect(prisma.inventoryEvent.update.mock.calls[0][0].data).toMatchObject({
      status: InventoryEventStatus.FAILED,
      lastError: 'Channel responded with HTTP 422',
    });
    expect(result.skipped).toBe(1);
  });

  it('propagates an auth failure so the runner can flip the connection to Action required', async () => {
    const { service, shopify } = build();
    shopify.setInventoryLevel.mockRejectedValue({ response: { status: 401 } });

    await expect(
      service.pushQuantities(integration(), [{ mappingId: 'map-1', quantity: 7 }]),
    ).rejects.toMatchObject({ response: { status: 401 } });
  });

  it('refuses to push at all when the credential cannot be decrypted', async () => {
    const { service, encryption } = build();
    encryption.decrypt.mockReturnValue(null);

    await expect(
      service.pushQuantities(integration(), [{ mappingId: 'map-1', quantity: 7 }]),
    ).rejects.toBeInstanceOf(PermanentIntegrationError);
  });

  it('never stores a provider response body against the mapping', async () => {
    const { service, prisma, shopify } = build();
    shopify.setInventoryLevel.mockRejectedValue({
      response: { status: 500, data: { token: 'shpat_leaked' } },
    });

    await service.pushQuantities(integration(), [
      { mappingId: 'map-1', quantity: 7 },
    ]);

    expect(JSON.stringify(prisma.integrationProductMapping.update.mock.calls)).not.toContain(
      'shpat_leaked',
    );
  });
});

describe('IntegrationPushService — fan-out targets', () => {
  beforeEach(() => jest.clearAllMocks());

  it('excludes the channel the change came from, so an update cannot bounce back', async () => {
    const { service, prisma } = build();

    await service.findFanOutTargets('seller-1', 'offer-1', 'int-source');

    const where = prisma.integrationProductMapping.findMany.mock.calls[0][0].where;
    expect(where.integrationId).toEqual({ not: 'int-source' });
  });

  it('excludes import-only channels, FBA rows and unresolved conflicts', async () => {
    const { service, prisma } = build();

    await service.findFanOutTargets('seller-1', 'offer-1', null);

    const where = prisma.integrationProductMapping.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({
      status: IntegrationMappingStatus.MAPPED,
      fulfillmentChannel: FulfillmentChannel.MERCHANT,
      inventoryConflictAt: null,
    });
    // Import-only means "read from here", so Yukizi must not write back.
    expect(where.integration.inventoryDirection).toEqual({
      in: [
        IntegrationSyncDirection.EXPORT_ONLY,
        IntegrationSyncDirection.TWO_WAY,
      ],
    });
    expect(where.integration).toMatchObject({
      status: IntegrationStatus.CONNECTED,
      syncEnabled: true,
      syncInventory: true,
    });
    // No exclusion when the change originated inside Yukizi.
    expect(where.integrationId).toBeUndefined();
  });
});
