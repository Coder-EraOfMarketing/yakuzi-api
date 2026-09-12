import { InventoryService } from './inventory.service';

/**
 * Stock without expiry.
 *
 * Batches came from the pharmaceutical marketplace this was forked from, where
 * a batch was a manufactured lot with a date on it. Yukizi sells collectables.
 * These pin the two things that must stay true: stock still works exactly as
 * it did, and no date is ever invented for it again.
 */
describe('InventoryService', () => {
  const build = (existingBatch: unknown = null) => {
    const prisma = {
      productBatch: {
        create: jest.fn().mockResolvedValue({ id: 'batch-1', stock: 5 }),
        findFirst: jest.fn().mockResolvedValue(existingBatch),
        update: jest.fn().mockResolvedValue({ id: 'batch-1', stock: 7 }),
      },
      inventoryAlert: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    return { service: new InventoryService(prisma as never), prisma };
  };

  it('creates a batch without inventing an expiry date', async () => {
    const { service, prisma } = build();

    await service.createDefaultBatch('offer-1', 5);

    const data = prisma.productBatch.create.mock.calls[0][0].data;
    expect(data).toEqual({ sellerOfferId: 'offer-1', batchNumber: 'DEFAULT', stock: 5 });
    expect(data).not.toHaveProperty('expiryDate');
  });

  it('updates stock without touching any date', async () => {
    const { service, prisma } = build({ id: 'batch-1', stock: 2 });

    await service.updateDefaultBatch('offer-1', 7);

    expect(prisma.productBatch.update).toHaveBeenCalledWith({
      where: { id: 'batch-1' },
      data: { stock: 7 },
    });
  });

  it('creates the batch when a listing has none yet — and still no date', async () => {
    const { service, prisma } = build(null);

    await service.updateDefaultBatch('offer-1', 3);

    expect(prisma.productBatch.create).toHaveBeenCalledWith({
      data: { sellerOfferId: 'offer-1', batchNumber: 'DEFAULT', stock: 3 },
    });
  });

  it('does not write when there is no stock figure to write', async () => {
    const existing = { id: 'batch-1', stock: 2 };
    const { service, prisma } = build(existing);

    await expect(service.updateDefaultBatch('offer-1')).resolves.toBe(existing);
    expect(prisma.productBatch.update).not.toHaveBeenCalled();
  });

  it('still raises an out-of-stock alert', async () => {
    const { service, prisma } = build({ id: 'batch-1', stock: 1 });
    prisma.productBatch.update.mockResolvedValue({ id: 'batch-1', stock: 0 });

    await service.updateDefaultBatch('offer-1', 0);
    await new Promise((r) => setImmediate(r)); // the alert check is detached

    const rows = prisma.inventoryAlert.createMany.mock.calls[0][0].data;
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toBe('Batch is out of stock');
  });

  it('still raises a low-stock alert', async () => {
    const { service, prisma } = build({ id: 'batch-1', stock: 20 });
    prisma.productBatch.update.mockResolvedValue({ id: 'batch-1', stock: 4 });

    await service.updateDefaultBatch('offer-1', 4);
    await new Promise((r) => setImmediate(r));

    expect(prisma.inventoryAlert.createMany.mock.calls[0][0].data[0].message).toBe(
      'Low stock: only 4 units remaining',
    );
  });

  it('never raises a near-expiry alert again', async () => {
    // A figure cannot go out of date; the admin was being told they do.
    const { service, prisma } = build({ id: 'batch-1', stock: 50 });
    prisma.productBatch.update.mockResolvedValue({ id: 'batch-1', stock: 50 });

    await service.updateDefaultBatch('offer-1', 50);
    await new Promise((r) => setImmediate(r));

    expect(prisma.inventoryAlert.createMany).not.toHaveBeenCalled();
  });

  it('sums stock across batches unchanged', async () => {
    const { service } = build();
    const prisma = (service as unknown as { prisma: Record<string, any> }).prisma;
    prisma.productBatch.aggregate = jest.fn().mockResolvedValue({ _sum: { stock: 12 } });

    await expect(service.getTotalStock('offer-1')).resolves.toBe(12);
  });
});
