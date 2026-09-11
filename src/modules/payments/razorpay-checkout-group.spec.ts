import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { OrderStatus, PaymentStatus } from '@prisma/client';
import { RazorpayService } from './razorpay.service';
import { checkoutGroupWhere, LEGACY_GROUP_WINDOW_MS } from './checkout-group';

/**
 * What the buyer is actually charged for a basket.
 *
 * A cart holding items from three sellers becomes three orders, and the
 * checkout page quotes one total. The payment has to cover that total: charging
 * only the order whose id the browser sent undercharged the buyer and left the
 * other sellers' orders unpaid until the abandonment sweep cancelled them.
 */
describe('RazorpayService.createOrder — charging the whole basket', () => {
  const USER = 'buyer-1';
  const PLACED_AT = new Date('2026-09-11T10:00:00.000Z');

  const order = (over: Record<string, unknown> = {}) => ({
    id: 'order-a',
    buyerId: USER,
    createdAt: PLACED_AT,
    checkoutGroupId: 'group-1',
    totalAmount: 500,
    paymentStatus: PaymentStatus.PENDING,
    ...over,
  });

  const build = (anchor = order(), unpaid: unknown[] = []) => {
    const prisma = {
      order: {
        findUnique: jest.fn().mockResolvedValue(anchor),
        findMany: jest.fn().mockResolvedValue(unpaid),
      },
      payment: { create: jest.fn().mockResolvedValue({ id: 'payment-1' }) },
    };
    const razorpayOrders = { create: jest.fn().mockResolvedValue({ id: 'order_RZP1' }) };
    const configService = {
      get: jest.fn((key: string) =>
        key === 'RAZORPAY_KEY_ID'
          ? 'rzp_test_key'
          : key === 'RAZORPAY_KEY_SECRET'
            ? 'secret'
            : undefined,
      ),
    };
    const service = new RazorpayService(
      configService as never,
      prisma as never,
      { confirmPayment: jest.fn() } as never,
    );
    // The Razorpay SDK is not reachable from a unit test; only the amount we
    // hand it matters here.
    (service as unknown as { client: unknown }).client = { orders: razorpayOrders };
    return { service, prisma, razorpayOrders };
  };

  it('charges the sum of every order the checkout produced', async () => {
    const { service, razorpayOrders } = build(order(), [
      { id: 'order-a', totalAmount: 500 },
      { id: 'order-b', totalAmount: 300 },
      { id: 'order-c', totalAmount: 120.5 },
    ]);

    const result = await service.createOrder(USER, 'order-a');

    // 920.50, not 500 — the figure the checkout page quoted.
    expect(razorpayOrders.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 92050, currency: 'INR' }),
    );
    expect(result.amount).toBe(92050);
  });

  it('records the payment for the basket, which is what confirms the group', async () => {
    const { service, prisma } = build(order(), [
      { id: 'order-a', totalAmount: 500 },
      { id: 'order-b', totalAmount: 300 },
    ]);

    await service.createOrder(USER, 'order-a');

    expect(prisma.payment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ orderId: 'order-a', amount: 800 }),
      }),
    );
  });

  it('lists every covered order on the Razorpay side, for reconciliation', async () => {
    const { service, razorpayOrders } = build(order(), [
      { id: 'order-a', totalAmount: 500 },
      { id: 'order-b', totalAmount: 300 },
    ]);

    await service.createOrder(USER, 'order-a');

    expect(razorpayOrders.create).toHaveBeenCalledWith(
      expect.objectContaining({
        receipt: 'order-a',
        notes: { orderId: 'order-a', orderIds: 'order-a,order-b' },
      }),
    );
  });

  it('asks the database only for unpaid, uncancelled orders in this group', async () => {
    const { service, prisma } = build(order(), [{ id: 'order-a', totalAmount: 500 }]);

    await service.createOrder(USER, 'order-a');

    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          checkoutGroupId: 'group-1',
          buyerId: USER,
          paymentStatus: { not: PaymentStatus.SUCCESS },
          orderStatus: { not: OrderStatus.CANCELLED },
        }),
      }),
    );
  });

  it('a single-seller basket is charged exactly as before', async () => {
    const { service, razorpayOrders } = build(order({ totalAmount: 185.58 }), [
      { id: 'order-a', totalAmount: 185.58 },
    ]);

    const result = await service.createOrder(USER, 'order-a');

    expect(razorpayOrders.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 18558 }),
    );
    expect(result.orderId).toBe('order-a');
  });

  it('refuses when nothing in the group is still owed', async () => {
    // Everything already paid, or cancelled out from under the retry.
    const { service } = build(order(), []);

    await expect(service.createOrder(USER, 'order-a')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('still refuses to start a payment on someone else’s order', async () => {
    const { service, prisma } = build(order({ buyerId: 'someone-else' }));

    await expect(service.createOrder(USER, 'order-a')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });
});

describe('checkoutGroupWhere', () => {
  it('uses the checkout id when the order has one', () => {
    expect(
      checkoutGroupWhere({
        buyerId: 'b1',
        createdAt: new Date('2026-09-11T10:00:00.000Z'),
        checkoutGroupId: 'group-1',
      }),
    ).toEqual({ checkoutGroupId: 'group-1' });
  });

  it('falls back to the old time window for orders placed before the column existed', () => {
    const createdAt = new Date('2026-09-11T10:00:00.000Z');

    const where = checkoutGroupWhere({ buyerId: 'b1', createdAt, checkoutGroupId: null });

    expect(where).toEqual({
      buyerId: 'b1',
      createdAt: {
        gte: new Date(createdAt.getTime() - LEGACY_GROUP_WINDOW_MS),
        lte: new Date(createdAt.getTime() + LEGACY_GROUP_WINDOW_MS),
      },
      // Never reach across into orders that do have a group id — those belong
      // to a checkout of their own.
      checkoutGroupId: null,
    });
  });
});
