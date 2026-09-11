import { OrderStatus, PaymentStatus, PaymentVerificationStatus } from '@prisma/client';
import { PaymentsService } from './payments.service';

const dec = (n: number) => ({ toNumber: () => n }) as never;

/**
 * The other half of the multi-seller fix: once the payment carries the whole
 * basket, confirming it has to mark every order in that basket paid — and tell
 * every seller in it. Before, only the order the payment was attached to was
 * settled, and the rest sat unpaid until the abandonment sweep cancelled them.
 */
describe('PaymentsService.confirmPayment — a basket paid once', () => {
  const BUYER = 'buyer-1';
  const PLACED_AT = new Date('2026-09-11T10:00:00.000Z');

  const relatedOrder = (id: string, total: number) => ({
    id,
    buyerId: BUYER,
    createdAt: PLACED_AT,
    checkoutGroupId: 'group-1',
    totalAmount: dec(total),
    orderStatus: OrderStatus.PLACED,
    items: [],
  });

  const build = () => {
    const orderUpdate = jest.fn().mockResolvedValue({});
    const tx = {
      payment: {
        update: jest.fn().mockResolvedValue({ id: 'payment-1' }),
        // No earlier confirmed payments against any of these orders.
        findMany: jest.fn().mockResolvedValue([]),
      },
      order: { update: orderUpdate },
      sellerSettlement: { findUnique: jest.fn(), create: jest.fn() },
    };

    const related = [
      relatedOrder('order-a', 500),
      relatedOrder('order-b', 300),
      relatedOrder('order-c', 120.5),
    ];

    const prisma = {
      payment: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'payment-1',
          orderId: 'order-a',
          // The basket total, as written by RazorpayService.createOrder.
          amount: dec(920.5),
          method: 'UPI',
          verificationStatus: PaymentVerificationStatus.PENDING,
          order: {
            id: 'order-a',
            buyerId: BUYER,
            createdAt: PLACED_AT,
            checkoutGroupId: 'group-1',
            totalAmount: dec(500),
          },
        }),
      },
      order: {
        findMany: jest.fn().mockResolvedValue(related),
        // notifyDeferredSellers claims nothing in this test.
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      $transaction: jest.fn(async (cb: (t: unknown) => unknown) => cb(tx)),
    };

    const invoiceEmailService = { dispatchForOrders: jest.fn() };
    const service = new PaymentsService(
      prisma as never,
      { get: jest.fn(() => '0.05') } as never,
      invoiceEmailService as never,
      { track: jest.fn() } as never,
      { notifySellersOfNewOrder: jest.fn() } as never,
    );
    return { service, prisma, tx, orderUpdate, invoiceEmailService };
  };

  it('marks every order in the basket paid, not just the one the payment is on', async () => {
    const { service, orderUpdate } = build();

    await service.confirmPayment('payment-1');

    expect(orderUpdate).toHaveBeenCalledTimes(3);
    for (const id of ['order-a', 'order-b', 'order-c']) {
      expect(orderUpdate).toHaveBeenCalledWith({
        where: { id },
        data: { paymentStatus: PaymentStatus.SUCCESS },
      });
    }
  });

  it('looks the basket up by its checkout id', async () => {
    const { service, prisma } = build();

    await service.confirmPayment('payment-1');

    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          checkoutGroupId: 'group-1',
          buyerId: BUYER,
        }),
      }),
    );
  });

  it('emails the invoice for every seller in the basket', async () => {
    const { service, invoiceEmailService } = build();

    await service.confirmPayment('payment-1');

    expect(invoiceEmailService.dispatchForOrders).toHaveBeenCalledWith([
      'order-a',
      'order-b',
      'order-c',
    ]);
  });

  it('tells the sellers of every order in the basket that they have one to ship', async () => {
    const { service, prisma } = build();

    await service.confirmPayment('payment-1');

    // notifyDeferredSellers runs detached; let its microtask land.
    await new Promise((resolve) => setImmediate(resolve));

    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: ['order-a', 'order-b', 'order-c'] },
          sellersNotifiedAt: null,
          paymentStatus: PaymentStatus.SUCCESS,
        }),
      }),
    );
  });
});
