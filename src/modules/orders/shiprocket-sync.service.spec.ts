import { OrderStatus, PaymentStatus } from '@prisma/client';
import { ShiprocketSyncService } from './shiprocket-sync.service';
import { payoutOrderItemInclude } from '../settlements/payout-calculator';

const build = () => {
  const prisma = {
    order: {
      findMany: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn(),
    },
  };
  const shiprocketService = {
    trackOrder: jest.fn(),
  };
  const ordersService = {
    syncTrackingFields: jest.fn().mockResolvedValue(undefined),
    createSettlementsForDeliveredOrder: jest.fn().mockResolvedValue(undefined),
  };
  const service = new ShiprocketSyncService(
    prisma as never,
    shiprocketService as never,
    ordersService as never,
  );
  return { service, prisma, shiprocketService, ordersService };
};

describe('ShiprocketSyncService.syncInFlightOrders', () => {
  it('queries only orders with a shiprocketOrderId not yet in a terminal state', async () => {
    const { service, prisma } = build();
    prisma.order.findMany.mockResolvedValue([]);

    await service.syncInFlightOrders();

    expect(prisma.order.findMany).toHaveBeenCalledWith({
      where: {
        shiprocketOrderId: { not: null },
        orderStatus: {
          notIn: [OrderStatus.DELIVERED, OrderStatus.RETURNED, OrderStatus.CANCELLED],
        },
      },
      select: { id: true, shiprocketOrderId: true, orderStatus: true },
    });
  });

  it('continues processing remaining orders when one order fails', async () => {
    const { service, prisma, shiprocketService } = build();
    prisma.order.findMany.mockResolvedValue([
      { id: 'order-1', shiprocketOrderId: 'sr-1', orderStatus: OrderStatus.SHIPPED },
      { id: 'order-2', shiprocketOrderId: 'sr-2', orderStatus: OrderStatus.SHIPPED },
    ]);
    shiprocketService.trackOrder
      .mockRejectedValueOnce(new Error('Shiprocket down'))
      .mockResolvedValueOnce({
        current_status: 'Out For Delivery',
        awb_code: 'AWB2',
        courier: 'DTDC',
      });

    await service.syncInFlightOrders();

    expect(shiprocketService.trackOrder).toHaveBeenCalledTimes(2);
    expect(prisma.order.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'order-2', orderStatus: OrderStatus.SHIPPED },
      data: { orderStatus: OrderStatus.OUT_FOR_DELIVERY },
    });
  });

  it("continues processing remaining orders when one order's DB write fails", async () => {
    const { service, prisma, shiprocketService } = build();
    prisma.order.findMany.mockResolvedValue([
      { id: 'order-1', shiprocketOrderId: 'sr-1', orderStatus: OrderStatus.SHIPPED },
      { id: 'order-2', shiprocketOrderId: 'sr-2', orderStatus: OrderStatus.SHIPPED },
    ]);
    shiprocketService.trackOrder.mockResolvedValue({
      current_status: 'Out For Delivery',
      awb_code: 'AWB',
      courier: 'DTDC',
    });
    prisma.order.updateMany
      .mockRejectedValueOnce(new Error('DB connection lost'))
      .mockResolvedValueOnce({ count: 1 });

    await service.syncInFlightOrders();

    expect(shiprocketService.trackOrder).toHaveBeenCalledTimes(2);
    expect(prisma.order.updateMany).toHaveBeenCalledTimes(2);
  });
});

describe('ShiprocketSyncService.syncOneOrder', () => {
  it('advances status and syncs tracking fields on a forward status move', async () => {
    const { service, prisma, shiprocketService, ordersService } = build();
    shiprocketService.trackOrder.mockResolvedValue({
      current_status: 'Out For Delivery',
      awb_code: 'AWB123',
      courier: 'Delhivery',
    });

    await service.syncOneOrder({
      id: 'order-1',
      shiprocketOrderId: 'sr-1',
      orderStatus: OrderStatus.SHIPPED,
    });

    expect(ordersService.syncTrackingFields).toHaveBeenCalledWith('order-1', {
      awb_code: 'AWB123',
      courier: 'Delhivery',
    });
    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'order-1', orderStatus: OrderStatus.SHIPPED },
      data: { orderStatus: OrderStatus.OUT_FOR_DELIVERY },
    });
  });

  it('does not update status when the mapped status is not a forward move', async () => {
    const { service, prisma, shiprocketService, ordersService } = build();
    shiprocketService.trackOrder.mockResolvedValue({
      current_status: 'Shipped',
      awb_code: 'AWB123',
      courier: 'Delhivery',
    });

    await service.syncOneOrder({
      id: 'order-1',
      shiprocketOrderId: 'sr-1',
      orderStatus: OrderStatus.OUT_FOR_DELIVERY,
    });

    expect(prisma.order.updateMany).not.toHaveBeenCalled();
    expect(ordersService.syncTrackingFields).not.toHaveBeenCalled();
  });

  it('does not update status when Shiprocket returns an unrecognized status', async () => {
    const { service, prisma, shiprocketService } = build();
    shiprocketService.trackOrder.mockResolvedValue({
      current_status: 'Some Brand New Courier Status',
    });

    await service.syncOneOrder({
      id: 'order-1',
      shiprocketOrderId: 'sr-1',
      orderStatus: OrderStatus.SHIPPED,
    });

    expect(prisma.order.updateMany).not.toHaveBeenCalled();
  });

  it('skips an order with no shiprocketOrderId without calling Shiprocket', async () => {
    const { service, shiprocketService, prisma } = build();

    await service.syncOneOrder({
      id: 'order-1',
      shiprocketOrderId: null,
      orderStatus: OrderStatus.SHIPPED,
    });

    expect(shiprocketService.trackOrder).not.toHaveBeenCalled();
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
  });

  it('backs off without creating settlements when the status changed concurrently (updateMany count 0)', async () => {
    const { service, prisma, shiprocketService, ordersService } = build();
    shiprocketService.trackOrder.mockResolvedValue({
      current_status: 'Delivered',
      awb_code: 'AWB123',
      courier: 'Delhivery',
    });
    prisma.order.updateMany.mockResolvedValue({ count: 0 });

    await service.syncOneOrder({
      id: 'order-1',
      shiprocketOrderId: 'sr-1',
      orderStatus: OrderStatus.OUT_FOR_DELIVERY,
    });

    expect(prisma.order.findUnique).not.toHaveBeenCalled();
    expect(ordersService.createSettlementsForDeliveredOrder).not.toHaveBeenCalled();
  });

  it('creates settlements when the status moves to DELIVERED', async () => {
    const { service, prisma, shiprocketService, ordersService } = build();
    shiprocketService.trackOrder.mockResolvedValue({
      current_status: 'Delivered',
      awb_code: 'AWB123',
      courier: 'Delhivery',
    });
    prisma.order.updateMany.mockResolvedValue({ count: 1 });
    const deliveredOrder = {
      id: 'order-1',
      orderStatus: OrderStatus.DELIVERED,
      paymentStatus: PaymentStatus.SUCCESS,
      items: [],
    };
    prisma.order.findUnique.mockResolvedValue(deliveredOrder);

    await service.syncOneOrder({
      id: 'order-1',
      shiprocketOrderId: 'sr-1',
      orderStatus: OrderStatus.OUT_FOR_DELIVERY,
    });

    // Asserted against the exported constant rather than a copy of its shape.
    // This is a settlement path, and a query that fetches less than the payout
    // engine reads resolves a 0% commission SILENTLY — which is how sellers
    // came to be billed a flat 5% with no GST. Pinning the constant means the
    // invariant under test is "this query uses the canonical include", which
    // stays true when the include grows; a hand-copied shape would merely go
    // stale and get "fixed" by pasting in whatever the code now sends.
    expect(prisma.order.findUnique).toHaveBeenCalledWith({
      where: { id: 'order-1' },
      include: { items: { include: payoutOrderItemInclude } },
    });
    expect(ordersService.createSettlementsForDeliveredOrder).toHaveBeenCalledWith(deliveredOrder);
  });

  it('does not create settlements when the mapped status is not DELIVERED', async () => {
    const { service, prisma, shiprocketService, ordersService } = build();
    shiprocketService.trackOrder.mockResolvedValue({
      current_status: 'Out For Delivery',
      awb_code: 'AWB123',
      courier: 'Delhivery',
    });
    prisma.order.updateMany.mockResolvedValue({ count: 1 });

    await service.syncOneOrder({
      id: 'order-1',
      shiprocketOrderId: 'sr-1',
      orderStatus: OrderStatus.SHIPPED,
    });

    expect(prisma.order.findUnique).not.toHaveBeenCalled();
    expect(ordersService.createSettlementsForDeliveredOrder).not.toHaveBeenCalled();
  });
});
