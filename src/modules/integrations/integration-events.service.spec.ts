import {
  IntegrationProvider,
  IntegrationSyncDirection,
  InventoryEventStatus,
  InventoryEventType,
  SyncJobType,
} from '@prisma/client';
import { IntegrationEventsService } from './integration-events.service';

const event = (over: Record<string, unknown> = {}) => ({
  id: 'evt-1',
  sellerId: 'seller-1',
  integrationId: 'int-1',
  mappingId: 'map-1',
  sellerOfferId: 'offer-1',
  sourcePlatform: IntegrationProvider.SHOPIFY,
  sourceEventId: 'wh-1',
  eventType: InventoryEventType.EXTERNAL_INVENTORY_CHANGE,
  status: InventoryEventStatus.PENDING,
  newQuantity: 7,
  ...over,
});

const mappingWith = (over: Record<string, unknown> = {}) => ({
  id: 'map-1',
  sellerOfferId: 'offer-1',
  externalSku: 'YK-1',
  inventoryConflictAt: null,
  integration: {
    id: 'int-1',
    syncEnabled: true,
    syncInventory: true,
    inventoryDirection: IntegrationSyncDirection.TWO_WAY,
    ...(over.integration as object),
  },
  ...over,
});

const build = () => {
  const prisma = {
    inventoryEvent: {
      findMany: jest.fn(async (_a?: any) => [event()]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn(),
    },
    integrationProductMapping: {
      // Typed loosely so a test can return null for the unmapped case.
      findUnique: jest.fn(async (): Promise<any> => mappingWith()),
      update: jest.fn(),
    },
    integrationSyncJob: { create: jest.fn() },
  };
  const inventory = {
    getTotalStock: jest.fn().mockResolvedValue(12),
    updateDefaultBatch: jest.fn(),
  };
  const integrations = { log: jest.fn() };
  const push = { findFanOutTargets: jest.fn().mockResolvedValue([]) };

  const service = new IntegrationEventsService(
    prisma as never,
    inventory as never,
    integrations as never,
    push as never,
  );
  return { service, prisma, inventory, integrations, push };
};

describe('IntegrationEventsService — applying channel changes', () => {
  beforeEach(() => jest.clearAllMocks());

  it('applies a real external change to Yukizi stock', async () => {
    const { service, inventory } = build();

    const result = await service.processPending();

    expect(inventory.updateDefaultBatch).toHaveBeenCalledWith('offer-1', 7);
    expect(result.processed).toBe(1);
  });

  it('claims each event with a compare-and-swap, so it cannot be applied twice', async () => {
    const { service, prisma } = build();

    await service.processPending();

    expect(prisma.inventoryEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'evt-1', status: InventoryEventStatus.PENDING },
      }),
    );
  });

  it('skips an event another instance already claimed', async () => {
    const { service, prisma, inventory } = build();
    prisma.inventoryEvent.updateMany.mockResolvedValue({ count: 0 });

    await service.processPending();

    expect(inventory.updateDefaultBatch).not.toHaveBeenCalled();
  });

  it('never processes our own outbound writes — the push service settles those', async () => {
    const { service, prisma } = build();

    await service.processPending();

    expect(prisma.inventoryEvent.findMany.mock.calls[0][0].where).toMatchObject({
      sourcePlatform: { not: 'YUKIZI' },
    });
  });

  it('does nothing when Yukizi already holds that quantity — where a would-be loop dies', async () => {
    const { service, inventory, prisma, push } = build();
    inventory.getTotalStock.mockResolvedValue(7); // same as the event

    const result = await service.processPending();

    expect(inventory.updateDefaultBatch).not.toHaveBeenCalled();
    expect(push.findFanOutTargets).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
    expect(prisma.inventoryEvent.update.mock.calls[0][0].data).toMatchObject({
      skipReason: 'QUANTITY_UNCHANGED',
    });
  });

  it('ignores what an export-only channel reports, since Yukizi drives it', async () => {
    const { service, prisma, inventory } = build();
    prisma.integrationProductMapping.findUnique.mockResolvedValue(
      mappingWith({
        integration: {
          id: 'int-1',
          syncEnabled: true,
          syncInventory: true,
          inventoryDirection: IntegrationSyncDirection.EXPORT_ONLY,
        },
      }),
    );

    await service.processPending();

    expect(inventory.updateDefaultBatch).not.toHaveBeenCalled();
    expect(prisma.inventoryEvent.update.mock.calls[0][0].data).toMatchObject({
      status: InventoryEventStatus.SKIPPED,
      skipReason: 'CHANNEL_IS_EXPORT_ONLY',
    });
  });

  it('does not pre-empt a seller who is being asked to resolve a difference', async () => {
    const { service, prisma, inventory } = build();
    prisma.integrationProductMapping.findUnique.mockResolvedValue(
      mappingWith({ inventoryConflictAt: new Date() }),
    );

    await service.processPending();

    expect(inventory.updateDefaultBatch).not.toHaveBeenCalled();
    expect(prisma.inventoryEvent.update.mock.calls[0][0].data).toMatchObject({
      skipReason: 'UNRESOLVED_CONFLICT',
    });
  });

  it('skips an event whose listing is not mapped to anything', async () => {
    const { service, prisma, inventory } = build();
    prisma.integrationProductMapping.findUnique.mockResolvedValue(null);

    await service.processPending();

    expect(inventory.updateDefaultBatch).not.toHaveBeenCalled();
    expect(prisma.inventoryEvent.update.mock.calls[0][0].data).toMatchObject({
      skipReason: 'NO_MAPPING',
    });
  });

  it('respects a seller who turned inventory sync off', async () => {
    const { service, prisma, inventory } = build();
    prisma.integrationProductMapping.findUnique.mockResolvedValue(
      mappingWith({
        integration: {
          id: 'int-1',
          syncEnabled: true,
          syncInventory: false,
          inventoryDirection: IntegrationSyncDirection.TWO_WAY,
        },
      }),
    );

    await service.processPending();

    expect(inventory.updateDefaultBatch).not.toHaveBeenCalled();
  });
});

describe('IntegrationEventsService — fan-out', () => {
  beforeEach(() => jest.clearAllMocks());

  it('queues a push for every OTHER channel carrying the listing', async () => {
    const { service, prisma, push } = build();
    push.findFanOutTargets.mockResolvedValue([
      { integrationId: 'int-woo', mappingId: 'map-woo' },
      { integrationId: 'int-amz', mappingId: 'map-amz' },
    ]);

    await service.processPending();

    // The source channel is excluded at the query level.
    expect(push.findFanOutTargets).toHaveBeenCalledWith(
      'seller-1',
      'offer-1',
      'int-1',
    );
    expect(prisma.integrationSyncJob.create).toHaveBeenCalledTimes(2);
    expect(prisma.integrationSyncJob.create.mock.calls[0][0].data).toMatchObject({
      jobType: SyncJobType.INVENTORY_PUSH,
      payload: { targets: [{ mappingId: 'map-woo', quantity: 7 }] },
    });
  });

  it('groups several mappings on one channel into a single job', async () => {
    const { service, prisma, push } = build();
    push.findFanOutTargets.mockResolvedValue([
      { integrationId: 'int-woo', mappingId: 'map-a' },
      { integrationId: 'int-woo', mappingId: 'map-b' },
    ]);

    await service.processPending();

    expect(prisma.integrationSyncJob.create).toHaveBeenCalledTimes(1);
    expect(
      prisma.integrationSyncJob.create.mock.calls[0][0].data.payload.targets,
    ).toHaveLength(2);
  });

  it('excludes nothing when the change originated inside Yukizi', async () => {
    const { service, push } = build();

    await service.fanOutYukiziChange('seller-1', 'offer-1', 4);

    expect(push.findFanOutTargets).toHaveBeenCalledWith('seller-1', 'offer-1', null);
  });
});
