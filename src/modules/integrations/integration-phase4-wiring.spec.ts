import { ConfigService } from '@nestjs/config';
import { BadRequestException } from '@nestjs/common';
import {
  IntegrationMappingStatus,
  IntegrationProvider,
  IntegrationStatus,
  Prisma,
} from '@prisma/client';
import { IntegrationPushService } from './integration-push.service';
import { IntegrationsService } from './integrations.service';
import {
  SHOPIFY_SCOPES,
  ShopifyProvider,
  shopifyScopesFor,
} from './providers/shopify.provider';

const config = (values: Record<string, string> = {}) =>
  ({ get: jest.fn((key: string) => values[key]) }) as unknown as ConfigService;

const integrationRow = (over: Record<string, unknown> = {}) =>
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
    scopes: [...SHOPIFY_SCOPES],
    syncEnabled: true,
    syncProducts: true,
    syncInventory: true,
    syncPrices: false,
    syncOrders: false,
    inventoryDirection: 'TWO_WAY',
    sourceOfTruth: 'YUKIZI',
    setupCompletedAt: new Date(),
    lastSyncAt: null,
    lastSuccessfulSyncAt: null,
    lastError: null,
    lastErrorAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    disconnectedAt: null,
    ...over,
  }) as never;

describe('Shopify scopes — least privilege for optional features', () => {
  it('asks for nothing extra by default', () => {
    expect(shopifyScopesFor({})).toEqual(SHOPIFY_SCOPES);
    // read_orders is protected customer data; write_products can change what a
    // live store charges. Neither belongs in the base set.
    expect(shopifyScopesFor({})).not.toContain('read_orders');
    expect(shopifyScopesFor({})).not.toContain('write_products');
  });

  it('adds exactly the scope each feature needs', () => {
    expect(shopifyScopesFor({ orders: true })).toContain('read_orders');
    expect(shopifyScopesFor({ orders: true })).not.toContain('write_products');
    expect(shopifyScopesFor({ prices: true })).toContain('write_products');
    expect(shopifyScopesFor({ orders: true, prices: true })).toEqual(
      expect.arrayContaining(['read_orders', 'write_products']),
    );
  });

  it('puts the requested scopes on the authorization URL', () => {
    const provider = new ShopifyProvider(
      config({
        SHOPIFY_CLIENT_ID: 'id',
        SHOPIFY_CLIENT_SECRET: 'secret',
        SHOPIFY_REDIRECT_URI: 'https://yukizi.com/cb',
      }),
    );

    const url = provider.buildAuthorizationUrl('demo.myshopify.com', 'state', {
      orders: true,
    });
    const scope = new URL(url).searchParams.get('scope') ?? '';
    expect(scope).toContain('read_orders');
    expect(scope).not.toContain('write_products');
  });
});

describe('IntegrationsService — reauthorization for new permissions', () => {
  const build = () => {
    const prisma = {
      sellerProfile: { findUnique: jest.fn().mockResolvedValue({ id: 'seller-1' }) },
      sellerIntegration: {
        findFirst: jest.fn(),
        update: jest.fn(async ({ data }: any) => integrationRow(data)),
      },
      integrationSyncJob: { findFirst: jest.fn(), create: jest.fn() },
      integrationLog: { create: jest.fn() },
    };
    const service = new IntegrationsService(
      prisma as never,
      { isConfigured: () => true } as never,
      { isConfigured: () => true } as never,
      { isConfigured: () => true } as never,
      { isConfigured: () => true } as never,
    );
    return { service, prisma };
  };

  it('flags a Shopify connection that lacks the scope an enabled feature needs', () => {
    const { service } = build();

    const view = service.toSellerView(
      integrationRow({ syncOrders: true, scopes: [...SHOPIFY_SCOPES] }),
    );

    // Scopes are fixed at authorisation, so the seller has to reconnect.
    expect(view.needsReauthorization).toBe(true);
    expect(view.missingScopes).toEqual(['read_orders']);
  });

  it('is satisfied once the scope has been granted', () => {
    const { service } = build();

    const view = service.toSellerView(
      integrationRow({
        syncOrders: true,
        scopes: [...SHOPIFY_SCOPES, 'read_orders'],
      }),
    );

    expect(view.needsReauthorization).toBe(false);
    expect(view.missingScopes).toEqual([]);
  });

  it('never asks WooCommerce to reauthorize — its key is read_write from the start', () => {
    const { service } = build();

    const view = service.toSellerView(
      integrationRow({
        provider: IntegrationProvider.WOOCOMMERCE,
        syncOrders: true,
        syncPrices: true,
        scopes: ['read_write'],
      }),
    );

    expect(view.needsReauthorization).toBe(false);
  });

  it('refuses to enable price sync on Amazon, whose offer structure is not implemented', async () => {
    const { service, prisma } = build();
    prisma.sellerIntegration.findFirst.mockResolvedValue(
      integrationRow({ provider: IntegrationProvider.AMAZON }),
    );

    await expect(
      service.updateSettings('user-1', 'int-1', { syncPrices: true }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.sellerIntegration.update).not.toHaveBeenCalled();
  });

  it('allows order sync to be turned on for Amazon', async () => {
    const { service, prisma } = build();
    prisma.sellerIntegration.findFirst.mockResolvedValue(
      integrationRow({ provider: IntegrationProvider.AMAZON }),
    );

    await service.updateSettings('user-1', 'int-1', { syncOrders: true });

    expect(prisma.sellerIntegration.update.mock.calls[0][0].data).toMatchObject({
      syncOrders: true,
    });
  });
});

describe('IntegrationPushService — price export', () => {
  const mapping = (over: Record<string, unknown> = {}) => ({
    id: 'map-1',
    integrationId: 'int-1',
    sellerOfferId: 'offer-1',
    status: IntegrationMappingStatus.MAPPED,
    externalProductId: 'p1',
    externalVariantId: 'v1',
    externalPrice: new Prisma.Decimal(1200),
    sellerOffer: { finalCustomerPayable: new Prisma.Decimal(999), mrp: new Prisma.Decimal(1500) },
    ...over,
  });

  const build = () => {
    const prisma = {
      integrationProductMapping: {
        findMany: jest.fn(async (_a?: any) => [mapping()]),
        update: jest.fn(),
      },
    };
    const encryption = {
      decrypt: jest.fn().mockReturnValue({
        accessToken: 'shpat_secret',
        consumerKey: 'ck',
        consumerSecret: 'cs',
      }),
    };
    const integrations = { log: jest.fn() };
    const shopify = { setVariantPrice: jest.fn() };
    const woocommerce = { updatePrice: jest.fn() };
    const amazon = {};

    const service = new IntegrationPushService(
      prisma as never,
      encryption as never,
      integrations as never,
      shopify as never,
      woocommerce as never,
      amazon as never,
    );
    jest
      .spyOn(IntegrationPushService.prototype as never, 'delay')
      .mockResolvedValue(undefined as never);
    return { service, prisma, shopify, woocommerce };
  };

  beforeEach(() => jest.clearAllMocks());

  it('does nothing at all when the seller has not opted in', async () => {
    const { service, shopify } = build();

    const result = await service.pushPrices(
      integrationRow({ syncPrices: false }),
      ['map-1'],
    );

    expect(result.pushed).toBe(0);
    expect(shopify.setVariantPrice).not.toHaveBeenCalled();
  });

  it('sends what a buyer actually pays, not the MRP', async () => {
    const { service, shopify } = build();

    await service.pushPrices(integrationRow({ syncPrices: true }), ['map-1']);

    // 999 is finalCustomerPayable; 1500 is the MRP and would misprice the store.
    expect(shopify.setVariantPrice).toHaveBeenCalledWith(
      'demo.myshopify.com',
      'shpat_secret',
      'v1',
      999,
    );
  });

  it('skips a listing whose price the channel already matches', async () => {
    const { service, prisma, shopify } = build();
    prisma.integrationProductMapping.findMany.mockResolvedValue([
      mapping({ externalPrice: new Prisma.Decimal(999) }),
    ]);

    const result = await service.pushPrices(
      integrationRow({ syncPrices: true }),
      ['map-1'],
    );

    expect(shopify.setVariantPrice).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });

  it('refuses to guess when a listing has no computed price', async () => {
    const { service, prisma, shopify } = build();
    prisma.integrationProductMapping.findMany.mockResolvedValue([
      mapping({ sellerOffer: { finalCustomerPayable: null, mrp: new Prisma.Decimal(1500) } }),
    ]);

    const result = await service.pushPrices(
      integrationRow({ syncPrices: true }),
      ['map-1'],
    );

    // Falling back to mrp would ignore GST and discounts.
    expect(shopify.setVariantPrice).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });

  it('does not attempt Amazon pricing, whose offer structure is not implemented', async () => {
    const { service, prisma } = build();

    const result = await service.pushPrices(
      integrationRow({ provider: IntegrationProvider.AMAZON, syncPrices: true }),
      ['map-1'],
    );

    expect(result).toEqual({ pushed: 0, skipped: 1 });
    expect(prisma.integrationProductMapping.findMany).not.toHaveBeenCalled();
  });

  it('writes WooCommerce prices through the regular-price field', async () => {
    const { service, woocommerce } = build();

    await service.pushPrices(
      integrationRow({
        provider: IntegrationProvider.WOOCOMMERCE,
        syncPrices: true,
        externalStoreUrl: 'https://mystore.com',
      }),
      ['map-1'],
    );

    expect(woocommerce.updatePrice).toHaveBeenCalledWith(
      'https://mystore.com',
      { consumerKey: 'ck', consumerSecret: 'cs' },
      'p1',
      'v1',
      999,
    );
  });

  it('records the new channel price so the next comparison is right', async () => {
    const { service, prisma } = build();

    await service.pushPrices(integrationRow({ syncPrices: true }), ['map-1']);

    expect(prisma.integrationProductMapping.update.mock.calls[0][0].data).toMatchObject({
      externalPrice: expect.anything(),
    });
  });
});
