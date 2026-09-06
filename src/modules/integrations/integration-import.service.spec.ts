import {
  FulfillmentChannel,
  IntegrationMappingStatus,
  IntegrationProvider,
  IntegrationStatus,
  InventoryEventStatus,
  InventorySourceOfTruth,
} from '@prisma/client';
import {
  CONFLICT_REASONS,
  IntegrationImportService,
  PermanentIntegrationError,
} from './integration-import.service';

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
    sourceOfTruth: InventorySourceOfTruth.YUKIZI,
    syncInventory: true,
    ...over,
  }) as never;

const build = () => {
  const state = {
    mappings: [] as any[],
    offers: [] as any[],
  };

  const prisma = {
    integrationProductMapping: {
      upsert: jest.fn(async ({ create }: any) => {
        const row = { id: `map-${state.mappings.length + 1}`, ...create };
        state.mappings.push(row);
        return row;
      }),
      // Typed with its argument so assertions can read back the where clause.
      findMany: jest.fn(async (_args?: any) => state.mappings),
      findFirst: jest.fn(),
      update: jest.fn(async ({ where, data }: any) => {
        const row = state.mappings.find((m) => m.id === where.id);
        if (row) Object.assign(row, data);
        return row ?? { id: where.id, ...data };
      }),
    },
    sellerOffer: { findMany: jest.fn(async () => state.offers) },
    inventoryEvent: {
      create: jest.fn(async ({ data }: any) => ({ id: 'evt-1', ...data })),
      update: jest.fn(),
    },
  };

  const encryption = {
    decrypt: jest.fn().mockReturnValue({ accessToken: 'shpat_secret' }),
  };
  const integrations = { log: jest.fn(), resolveSellerId: jest.fn(), requireOwnedIntegration: jest.fn() };
  const inventory = {
    getTotalStock: jest.fn().mockResolvedValue(0),
    updateDefaultBatch: jest.fn(),
  };
  const shopify = { fetchProductsPage: jest.fn() };
  const woocommerce = { fetchProductsPage: jest.fn() };
  const amazon = { fetchListingsPage: jest.fn() };

  const service = new IntegrationImportService(
    prisma as never,
    encryption as never,
    integrations as never,
    inventory as never,
    shopify as never,
    woocommerce as never,
    amazon as never,
  );

  return { service, prisma, state, encryption, integrations, inventory, shopify };
};

const externalProduct = (over: Record<string, unknown> = {}) => ({
  externalProductId: 'p1',
  externalVariantId: 'v1',
  sku: 'YK-1043',
  title: 'Naruto Figure',
  quantity: 12,
  fulfillmentChannel: 'MERCHANT' as const,
  ...over,
});

describe('IntegrationImportService — SKU matching', () => {
  beforeEach(() => jest.clearAllMocks());

  it('matches an external listing to the Yukizi listing with the same SKU', async () => {
    const { service, state, shopify } = build();
    state.offers = [
      { id: 'offer-1', sku: 'YK-1043', catalogProductId: 'cat-1', variant: null },
      { id: 'offer-2', sku: 'YK-9999', catalogProductId: 'cat-2', variant: null },
    ];
    shopify.fetchProductsPage.mockResolvedValue({
      products: [externalProduct()],
      nextCursor: null,
    });

    const result = await service.importCatalogue(integration());

    expect(result).toMatchObject({ imported: 1, matched: 1, conflicts: 0 });
    expect(state.mappings[0]).toMatchObject({
      sellerOfferId: 'offer-1',
      status: IntegrationMappingStatus.MAPPED,
    });
  });

  it('matches on the variant SKU when the listing SKU does not match', async () => {
    const { service, state, shopify } = build();
    state.offers = [
      {
        id: 'offer-1',
        sku: null,
        catalogProductId: null,
        variant: { sku: 'YK-1043', catalogProductId: 'cat-9' },
      },
    ];
    shopify.fetchProductsPage.mockResolvedValue({
      products: [externalProduct()],
      nextCursor: null,
    });

    await service.importCatalogue(integration());

    expect(state.mappings[0]).toMatchObject({
      sellerOfferId: 'offer-1',
      catalogProductId: 'cat-9',
      status: IntegrationMappingStatus.MAPPED,
    });
  });

  it('matches SKUs case-insensitively and ignores surrounding whitespace', async () => {
    const { service, state, shopify } = build();
    state.offers = [
      { id: 'offer-1', sku: '  yk-1043 ', catalogProductId: 'c', variant: null },
    ];
    shopify.fetchProductsPage.mockResolvedValue({
      products: [externalProduct({ sku: 'YK-1043' })],
      nextCursor: null,
    });

    await service.importCatalogue(integration());

    expect(state.mappings[0].status).toBe(IntegrationMappingStatus.MAPPED);
  });

  it('NEVER matches on product name — a same-named product with a different SKU stays unmapped', async () => {
    const { service, state, shopify } = build();
    state.offers = [
      {
        id: 'offer-1',
        sku: 'DIFFERENT-SKU',
        catalogProductId: 'c',
        variant: null,
        name: 'Naruto Figure',
      },
    ];
    shopify.fetchProductsPage.mockResolvedValue({
      products: [externalProduct({ sku: 'YK-1043', title: 'Naruto Figure' })],
      nextCursor: null,
    });

    const result = await service.importCatalogue(integration());

    expect(result.matched).toBe(0);
    expect(state.mappings[0]).toMatchObject({
      sellerOfferId: null,
      status: IntegrationMappingStatus.UNMAPPED,
    });
  });

  it('refuses to choose when one SKU matches several Yukizi listings', async () => {
    const { service, state, shopify } = build();
    state.offers = [
      { id: 'offer-1', sku: 'YK-1043', catalogProductId: 'c1', variant: null },
      { id: 'offer-2', sku: 'YK-1043', catalogProductId: 'c2', variant: null },
    ];
    shopify.fetchProductsPage.mockResolvedValue({
      products: [externalProduct()],
      nextCursor: null,
    });

    const result = await service.importCatalogue(integration());

    expect(result.conflicts).toBe(1);
    expect(state.mappings[0]).toMatchObject({
      status: IntegrationMappingStatus.CONFLICT,
      conflictReason: CONFLICT_REASONS.MULTIPLE_YUKIZI,
      sellerOfferId: null,
    });
  });

  it('refuses to choose when two external listings share one SKU', async () => {
    const { service, state, shopify } = build();
    state.offers = [
      { id: 'offer-1', sku: 'YK-1043', catalogProductId: 'c1', variant: null },
    ];
    shopify.fetchProductsPage.mockResolvedValue({
      products: [
        externalProduct({ externalVariantId: 'v1' }),
        externalProduct({ externalVariantId: 'v2' }),
      ],
      nextCursor: null,
    });

    const result = await service.importCatalogue(integration());

    expect(result.conflicts).toBe(2);
    for (const mapping of state.mappings) {
      expect(mapping.status).toBe(IntegrationMappingStatus.CONFLICT);
      expect(mapping.conflictReason).toBe(CONFLICT_REASONS.SHARED_EXTERNAL);
      expect(mapping.sellerOfferId).toBeNull();
    }
  });

  it('flags a listing with no SKU as MISSING_SKU rather than guessing', async () => {
    const { service, state, shopify } = build();
    state.offers = [
      { id: 'offer-1', sku: 'YK-1043', catalogProductId: 'c1', variant: null },
    ];
    shopify.fetchProductsPage.mockResolvedValue({
      products: [externalProduct({ sku: null })],
      nextCursor: null,
    });

    await service.importCatalogue(integration());

    expect(state.mappings[0]).toMatchObject({
      status: IntegrationMappingStatus.MISSING_SKU,
      conflictReason: CONFLICT_REASONS.NO_SKU,
    });
  });

  it("leaves a seller's manual mapping alone on re-import", async () => {
    const { service, state, prisma, shopify } = build();
    state.offers = [
      { id: 'offer-2', sku: 'YK-1043', catalogProductId: 'c', variant: null },
    ];
    // A row the seller mapped by hand to a DIFFERENT product.
    prisma.integrationProductMapping.upsert.mockImplementation(async () => {
      const row = {
        id: 'map-1',
        externalSku: 'YK-1043',
        sellerOfferId: 'offer-manual',
        mappedManuallyAt: new Date(),
        status: IntegrationMappingStatus.MAPPED,
      };
      state.mappings.push(row);
      return row;
    });
    shopify.fetchProductsPage.mockResolvedValue({
      products: [externalProduct()],
      nextCursor: null,
    });

    await service.importCatalogue(integration());

    expect(prisma.integrationProductMapping.update).not.toHaveBeenCalled();
    expect(state.mappings[0].sellerOfferId).toBe('offer-manual');
  });

  it('stops paging at the run limit and hands back the cursor to continue from', async () => {
    const { service, shopify } = build();
    // Skip the real inter-page pause; this test is about the page budget, not
    // about waiting 12 seconds for it.
    jest
      .spyOn(IntegrationImportService.prototype as never, 'delay')
      .mockResolvedValue(undefined as never);
    shopify.fetchProductsPage.mockResolvedValue({
      products: [],
      nextCursor: 'always-more',
    });

    const result = await service.importCatalogue(integration());

    // Bounded: one seller's endless catalogue cannot monopolise the runner.
    expect(shopify.fetchProductsPage).toHaveBeenCalledTimes(20);
    expect(result.nextCursor).toBe('always-more');
  });

  it('treats undecryptable credentials as permanent, so the runner stops retrying', async () => {
    const { service, encryption } = build();
    encryption.decrypt.mockReturnValue(null);

    await expect(service.importCatalogue(integration())).rejects.toBeInstanceOf(
      PermanentIntegrationError,
    );
  });
});

describe('IntegrationImportService — inventory import', () => {
  beforeEach(() => jest.clearAllMocks());

  const mappedRow = (over: Record<string, unknown> = {}) => ({
    id: 'map-1',
    sellerOfferId: 'offer-1',
    externalSku: 'YK-1043',
    externalQuantity: 7,
    inventoryConflictAt: null,
    status: IntegrationMappingStatus.MAPPED,
    fulfillmentChannel: FulfillmentChannel.MERCHANT,
    ...over,
  });

  it('never asks Amazon FBA stock to be applied — the query excludes it', async () => {
    const { service, prisma } = build();
    prisma.integrationProductMapping.findMany.mockResolvedValue([]);

    await service.importInventory(integration());

    // FBA sits in Amazon's warehouses; Yukizi may display it but must not
    // treat it as seller-controlled stock.
    expect(prisma.integrationProductMapping.findMany.mock.calls[0][0].where)
      .toMatchObject({ fulfillmentChannel: FulfillmentChannel.MERCHANT });
  });

  it('flags a difference instead of overwriting when Yukizi is the source of truth', async () => {
    const { service, prisma, inventory } = build();
    prisma.integrationProductMapping.findMany.mockResolvedValue([mappedRow()]);
    inventory.getTotalStock.mockResolvedValue(12); // Yukizi 12 vs channel 7

    const result = await service.importInventory(integration());

    expect(result).toMatchObject({ applied: 0, conflicts: 1 });
    // Crucially: the seller's real stock was NOT touched.
    expect(inventory.updateDefaultBatch).not.toHaveBeenCalled();
    expect(prisma.integrationProductMapping.update.mock.calls[0][0].data)
      .toMatchObject({ conflictYukiziQuantity: 12 });
  });

  it('applies the channel quantity when the seller made that channel the source of truth', async () => {
    const { service, prisma, inventory } = build();
    prisma.integrationProductMapping.findMany.mockResolvedValue([mappedRow()]);
    inventory.getTotalStock.mockResolvedValue(12);

    const result = await service.importInventory(
      integration({ sourceOfTruth: InventorySourceOfTruth.EXTERNAL }),
    );

    expect(result.applied).toBe(1);
    expect(inventory.updateDefaultBatch).toHaveBeenCalledWith('offer-1', 7);
  });

  it('leaves an already-flagged difference untouched until the seller resolves it', async () => {
    const { service, prisma, inventory } = build();
    prisma.integrationProductMapping.findMany.mockResolvedValue([
      mappedRow({ inventoryConflictAt: new Date() }),
    ]);
    inventory.getTotalStock.mockResolvedValue(12);

    const result = await service.importInventory(
      integration({ sourceOfTruth: InventorySourceOfTruth.EXTERNAL }),
    );

    expect(result.conflicts).toBe(1);
    expect(inventory.updateDefaultBatch).not.toHaveBeenCalled();
  });

  it('does nothing when both sides already agree, and clears a stale flag', async () => {
    const { service, prisma, inventory } = build();
    prisma.integrationProductMapping.findMany.mockResolvedValue([
      mappedRow({ externalQuantity: 12, inventoryConflictAt: new Date() }),
    ]);
    inventory.getTotalStock.mockResolvedValue(12);

    const result = await service.importInventory(integration());

    expect(result.skipped).toBe(1);
    expect(inventory.updateDefaultBatch).not.toHaveBeenCalled();
    expect(prisma.integrationProductMapping.update.mock.calls[0][0].data)
      .toMatchObject({ inventoryConflictAt: null });
  });

  it('records the stock write in the ledger, marking it processed only after it succeeds', async () => {
    const { service, prisma, inventory } = build();

    await service.applyExternalQuantity(
      integration(),
      'map-1',
      'offer-1',
      12,
      7,
    );

    const event = prisma.inventoryEvent.create.mock.calls[0][0].data;
    expect(event).toMatchObject({
      status: InventoryEventStatus.PENDING,
      oldQuantity: 12,
      newQuantity: 7,
      quantityDelta: -5,
    });
    expect(inventory.updateDefaultBatch).toHaveBeenCalledWith('offer-1', 7);
    expect(prisma.inventoryEvent.update.mock.calls[0][0].data).toMatchObject({
      status: InventoryEventStatus.PROCESSED,
    });
  });
});

describe('IntegrationImportService — resolving a difference', () => {
  beforeEach(() => jest.clearAllMocks());

  const setup = () => {
    const ctx = build();
    ctx.integrations.resolveSellerId.mockResolvedValue('seller-1');
    ctx.integrations.requireOwnedIntegration.mockResolvedValue(integration());
    ctx.prisma.integrationProductMapping.findFirst.mockResolvedValue({
      id: 'map-1',
      sellerOfferId: 'offer-1',
      externalSku: 'YK-1043',
      externalQuantity: 7,
      inventoryConflictAt: new Date(),
    });
    return ctx;
  };

  it('imports the channel quantity when the seller picks the channel', async () => {
    const { service, inventory } = setup();
    inventory.getTotalStock.mockResolvedValue(12);

    const result = await service.resolveInventoryConflict(
      'user-1',
      'int-1',
      'map-1',
      'EXTERNAL',
    );

    expect(result).toEqual({ resolved: true, appliedTo: 'YUKIZI' });
    expect(inventory.updateDefaultBatch).toHaveBeenCalledWith('offer-1', 7);
  });

  it('keeps the Yukizi quantity and only clears the flag when the seller picks Yukizi', async () => {
    const { service, inventory, prisma } = setup();

    const result = await service.resolveInventoryConflict(
      'user-1',
      'int-1',
      'map-1',
      'YUKIZI',
    );

    // Honest: nothing is pushed outward yet, so nothing claims to have been.
    expect(result).toEqual({ resolved: true, appliedTo: 'NONE' });
    expect(inventory.updateDefaultBatch).not.toHaveBeenCalled();
    expect(prisma.integrationProductMapping.update.mock.calls[0][0].data)
      .toMatchObject({ inventoryConflictAt: null });
  });

  it('goes through the shared ownership check, so another seller cannot resolve this', async () => {
    const { service, integrations } = setup();

    await service.resolveInventoryConflict('user-1', 'int-1', 'map-1', 'YUKIZI');

    expect(integrations.requireOwnedIntegration).toHaveBeenCalledWith(
      'seller-1',
      'int-1',
    );
  });

  it('rejects resolving a difference that is no longer open', async () => {
    const { service, prisma } = setup();
    prisma.integrationProductMapping.findFirst.mockResolvedValue(null);

    await expect(
      service.resolveInventoryConflict('user-1', 'int-1', 'map-1', 'YUKIZI'),
    ).rejects.toBeInstanceOf(PermanentIntegrationError);
  });
});
