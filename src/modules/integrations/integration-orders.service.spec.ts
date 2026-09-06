import {
  IntegrationProvider,
  IntegrationStatus,
  Prisma,
} from '@prisma/client';
import { IntegrationOrdersService } from './integration-orders.service';
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
    syncOrders: true,
    ...over,
  }) as never;

const externalOrder = (over: Record<string, unknown> = {}) => ({
  externalOrderId: '5001',
  orderNumber: '#1001',
  placedAt: new Date('2026-09-01T10:00:00.000Z'),
  status: 'fulfilled',
  financialStatus: 'paid',
  currency: 'INR',
  totalAmount: 1600,
  cancelledAt: null,
  items: [
    { sku: 'YK-1', title: 'Naruto Figure', quantity: 2, price: 800 },
  ],
  ...over,
});

const build = () => {
  const prisma = {
    integrationExternalOrder: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      upsert: jest.fn(),
    },
    // Present so a test can prove they are never touched.
    order: { create: jest.fn(), createMany: jest.fn() },
    orderItem: { create: jest.fn(), createMany: jest.fn() },
    productBatch: { update: jest.fn() },
    inventoryEvent: { create: jest.fn() },
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
  const integrations = { log: jest.fn(), resolveSellerId: jest.fn() };
  const shopify = {
    fetchOrdersPage: jest
      .fn()
      .mockResolvedValue({ orders: [externalOrder()], nextCursor: null }),
  };
  const woocommerce = { fetchOrdersPage: jest.fn() };
  const amazon = { fetchOrdersPage: jest.fn() };

  const service = new IntegrationOrdersService(
    prisma as never,
    encryption as never,
    integrations as never,
    shopify as never,
    woocommerce as never,
    amazon as never,
  );
  return { service, prisma, encryption, integrations, shopify, woocommerce, amazon };
};

describe('IntegrationOrdersService — safety properties', () => {
  beforeEach(() => jest.clearAllMocks());

  it('NEVER writes a Yukizi order or order item — settlements are computed from those', async () => {
    const { service, prisma } = build();

    await service.importOrders(integration());

    // Writing here would make Yukizi owe the seller money for a sale it never
    // processed and never collected payment for.
    expect(prisma.order.create).not.toHaveBeenCalled();
    expect(prisma.order.createMany).not.toHaveBeenCalled();
    expect(prisma.orderItem.create).not.toHaveBeenCalled();
    expect(prisma.orderItem.createMany).not.toHaveBeenCalled();
    // It lands in the separate channel ledger instead.
    expect(prisma.integrationExternalOrder.upsert).toHaveBeenCalled();
  });

  it('NEVER moves stock — inventory arrives as an absolute quantity elsewhere', async () => {
    const { service, prisma } = build();

    await service.importOrders(integration());

    // Applying an order as a delta on top of absolute inventory levels would
    // deduct the same sale twice.
    expect(prisma.productBatch.update).not.toHaveBeenCalled();
    expect(prisma.inventoryEvent.create).not.toHaveBeenCalled();
  });

  it('stores no customer identity', async () => {
    const { service, prisma } = build();

    await service.importOrders(integration());

    const written = JSON.stringify(
      prisma.integrationExternalOrder.upsert.mock.calls[0][0],
    );
    for (const field of ['email', 'phone', 'address', 'customer', 'buyer']) {
      expect(written.toLowerCase()).not.toContain(field);
    }
  });
});

describe('IntegrationOrdersService — importing', () => {
  beforeEach(() => jest.clearAllMocks());

  it('upserts on the channel order id so a re-import updates rather than duplicates', async () => {
    const { service, prisma } = build();

    await service.importOrders(integration());

    const call = prisma.integrationExternalOrder.upsert.mock.calls[0][0];
    expect(call.where).toEqual({
      integrationId_externalOrderId: {
        integrationId: 'int-1',
        externalOrderId: '5001',
      },
    });
    expect(call.create).toMatchObject({
      sellerId: 'seller-1',
      orderNumber: '#1001',
      itemCount: 2,
    });
    expect(call.create.totalAmount).toBeInstanceOf(Prisma.Decimal);
  });

  it('reaches back 30 days on a first import', async () => {
    const { service, shopify } = build();

    await service.importOrders(integration());

    const since: Date = shopify.fetchOrdersPage.mock.calls[0][2];
    const days = (Date.now() - since.getTime()) / 86_400_000;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThan(31);
  });

  it('resumes from the newest stored order, with a day of overlap so nothing slips through', async () => {
    const { service, prisma, shopify } = build();
    const newest = new Date('2026-09-05T00:00:00.000Z');
    prisma.integrationExternalOrder.findFirst.mockResolvedValue({
      placedAt: newest,
    });

    await service.importOrders(integration());

    const since: Date = shopify.fetchOrdersPage.mock.calls[0][2];
    expect(newest.getTime() - since.getTime()).toBe(86_400_000);
  });

  it('stops at the page budget and hands back a cursor to continue from', async () => {
    const { service, shopify } = build();
    shopify.fetchOrdersPage.mockResolvedValue({
      orders: [],
      nextCursor: 'more',
    });

    const result = await service.importOrders(integration());

    expect(shopify.fetchOrdersPage).toHaveBeenCalledTimes(5);
    expect(result.nextCursor).toBe('more');
  });

  it('routes each provider to its own order endpoint', async () => {
    const { service, woocommerce, amazon } = build();
    woocommerce.fetchOrdersPage.mockResolvedValue({ orders: [], nextCursor: null });
    amazon.fetchOrdersPage.mockResolvedValue({ orders: [], nextCursor: null });

    await service.importOrders(
      integration({ provider: IntegrationProvider.WOOCOMMERCE }),
    );
    expect(woocommerce.fetchOrdersPage).toHaveBeenCalled();

    await service.importOrders(
      integration({ provider: IntegrationProvider.AMAZON, marketplaceId: 'A21', region: 'eu' }),
    );
    expect(amazon.fetchOrdersPage).toHaveBeenCalledWith(
      expect.objectContaining({ marketplaceId: 'A21', region: 'eu' }),
      expect.any(Date),
      null,
    );
  });

  it('treats undecryptable credentials as permanent', async () => {
    const { service, encryption } = build();
    encryption.decrypt.mockReturnValue(null);

    await expect(service.importOrders(integration())).rejects.toBeInstanceOf(
      PermanentIntegrationError,
    );
  });
});

describe('IntegrationOrdersService — listing for the seller', () => {
  beforeEach(() => jest.clearAllMocks());

  it('scopes to the seller resolved from the JWT', async () => {
    const { service, prisma, integrations } = build();
    integrations.resolveSellerId.mockResolvedValue('seller-1');

    await service.listOrders('user-1', { integrationId: 'int-1' });

    expect(prisma.integrationExternalOrder.findMany.mock.calls[0][0].where).toEqual({
      sellerId: 'seller-1',
      integrationId: 'int-1',
    });
  });
});
