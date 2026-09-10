import { OrdersService } from './orders.service';
import type { CreateOrderDto } from './dto/create-order.dto';
import { OrderStatus, PaymentStatus, Role } from '@prisma/client';

const dto = (over: Partial<CreateOrderDto> = {}): CreateOrderDto =>
  ({
    name: 'Arko',
    phone: '9008336683',
    address: 'sss',
    city: 'ss',
    state: 'West Bengal',
    pincode: '711303',
    email: 'buyer@example.com',
    ...over,
  }) as CreateOrderDto;

const build = (
  user: { phone?: string | null; email?: string | null },
  emailTakenBy: string | null = null,
) => {
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue({
        phone: user.phone ?? null,
        email: user.email ?? null,
        buyerProfile: null,
      }),
      findFirst: jest
        .fn()
        .mockImplementation(({ where }: never) =>
          Promise.resolve(
            (where as { email?: string }).email && emailTakenBy
              ? { id: emailTakenBy }
              : null,
          ),
        ),
      update: jest.fn().mockResolvedValue({}),
    },
    buyerProfile: { update: jest.fn().mockResolvedValue({}) },
  };
  const service = new OrdersService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, prisma };
};

describe('OrdersService.syncBuyerContactDetails — email', () => {
  const call = (service: OrdersService, d: CreateOrderDto) =>
    (
      service as unknown as {
        syncBuyerContactDetails(u: string, d: CreateOrderDto): Promise<void>;
      }
    ).syncBuyerContactDetails('user-1', d);

  it('claims a blank email from checkout', async () => {
    const { service, prisma } = build({ email: null });
    await call(service, dto());
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        // expect.objectContaining returns `any`, which no-unsafe-assignment
        // flags here — safe, this is a Jest matcher, not real data.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        data: expect.objectContaining({ email: 'buyer@example.com' }),
      }),
    );
  });

  it('never overwrites an email the account already has', async () => {
    const { service, prisma } = build({ email: 'existing@example.com' });
    await call(service, dto());
    const updates = prisma.user.update.mock.calls.filter(
      (c: never[]) => 'email' in (c[0] as { data: object }).data,
    );
    expect(updates).toHaveLength(0);
  });

  it('does not claim an email another account already holds', async () => {
    const { service, prisma } = build({ email: null }, 'someone-else');
    await call(service, dto());
    const updates = prisma.user.update.mock.calls.filter(
      (c: never[]) => 'email' in (c[0] as { data: object }).data,
    );
    expect(updates).toHaveLength(0);
  });

  it('lowercases and trims the address before storing it', async () => {
    const { service, prisma } = build({ email: null });
    await call(service, dto({ email: '  Buyer@Example.COM ' }));
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        data: expect.objectContaining({ email: 'buyer@example.com' }),
      }),
    );
  });

  it('does nothing when no email was supplied', async () => {
    const { service, prisma } = build({ email: null });
    await call(service, dto({ email: undefined }));
    const updates = prisma.user.update.mock.calls.filter(
      (c: never[]) => 'email' in (c[0] as { data: object }).data,
    );
    expect(updates).toHaveLength(0);
  });
});

describe('OrdersService.pushOrderToShiprocketIfNeeded', () => {
  const baseOrder = (over: Record<string, unknown> = {}) => ({
    id: 'order-1',
    createdAt: new Date('2026-08-08T10:00:00Z'),
    totalAmount: 500,
    paymentStatus: 'SUCCESS',
    shiprocketOrderId: null,
    packageLength: null,
    packageBreadth: null,
    packageHeight: null,
    packageWeight: null,
    address: {
      name: 'Buyer Name',
      address: 'Street 1',
      city: 'Kolkata',
      pincode: '700001',
      state: 'West Bengal',
      phone: '9000000000',
    },
    buyer: { email: 'buyer@example.com', phone: '9000000000', buyerProfile: null },
    items: [
      {
        quantity: 2,
        unitPrice: 250,
        sellerOffer: { id: 'offer-12345678', name: 'Manga Vol 1' },
      },
    ],
    ...over,
  });

  const build = (createOrderImpl?: jest.Mock, getPickupImpl?: jest.Mock) => {
    const shiprocketService = {
      getPrimaryPickupLocation: getPickupImpl ?? jest.fn().mockResolvedValue('Home'),
      createOrder:
        createOrderImpl ??
        jest.fn().mockResolvedValue({
          order_id: 'sr-order-1',
          shipment_id: 'sr-shipment-1',
          awb_code: null,
          courier_name: null,
        }),
    };
    const service = new OrdersService(
      {} as never,
      shiprocketService as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { service, shiprocketService };
  };

  it('no-ops when the order was already pushed', async () => {
    const { service, shiprocketService } = build();
    const result = await service.pushOrderToShiprocketIfNeeded(
      baseOrder({ shiprocketOrderId: 'already-there' }) as never,
    );
    expect(result).toEqual({});
    expect(shiprocketService.createOrder).not.toHaveBeenCalled();
  });

  it('sends the seller-submitted package dimensions, not the 10x10x10/1kg placeholder', async () => {
    const { service, shiprocketService } = build();
    await service.pushOrderToShiprocketIfNeeded(
      baseOrder({
        packageLength: 25,
        packageBreadth: 15,
        packageHeight: 8,
        packageWeight: 1.4,
      }) as never,
    );
    const payload = shiprocketService.createOrder.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(payload).toMatchObject({
      length: 25,
      breadth: 15,
      height: 8,
      weight: 1.4,
    });
  });

  it('falls back to placeholder dimensions when the seller never submitted any', async () => {
    const { service, shiprocketService } = build();
    await service.pushOrderToShiprocketIfNeeded(baseOrder() as never);
    const payload = shiprocketService.createOrder.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(payload).toMatchObject({
      length: 10,
      breadth: 10,
      height: 10,
      weight: 1,
    });
  });

  it('sends a numeric placeholder HSN, not null (Shiprocket 422s on null)', async () => {
    const { service, shiprocketService } = build();
    await service.pushOrderToShiprocketIfNeeded(baseOrder() as never);
    const payload = shiprocketService.createOrder.mock.calls[0][0] as {
      order_items: Array<Record<string, unknown>>;
    };
    expect(payload.order_items[0].hsn).toBe('9999');
  });

  it('returns the Shiprocket-assigned fields to merge into the order update', async () => {
    const { service } = build(
      jest.fn().mockResolvedValue({
        order_id: 'sr-order-9',
        shipment_id: 'sr-shipment-9',
        awb_code: 'AWB9',
        courier_name: 'Delhivery',
      }),
    );
    const result = await service.pushOrderToShiprocketIfNeeded(
      baseOrder() as never,
    );
    expect(result).toEqual({
      shiprocketOrderId: 'sr-order-9',
      shipmentId: 'sr-shipment-9',
      awbCode: 'AWB9',
      courierName: 'Delhivery',
    });
  });

  it('swallows a Shiprocket API failure and returns {} instead of throwing', async () => {
    const { service } = build(
      jest.fn().mockRejectedValue(new Error('Shiprocket down')),
    );
    const result = await service.pushOrderToShiprocketIfNeeded(
      baseOrder() as never,
    );
    expect(result).toEqual({});
  });

  it('uses the pickup location resolved from Shiprocket, not a hardcoded "Primary"', async () => {
    const { service, shiprocketService } = build(
      undefined,
      jest.fn().mockResolvedValue('Warehouse'),
    );
    await service.pushOrderToShiprocketIfNeeded(baseOrder() as never);
    const payload = shiprocketService.createOrder.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(payload.pickup_location).toBe('Warehouse');
  });

  it('swallows a pickup-location lookup failure and returns {} instead of throwing', async () => {
    const { service, shiprocketService } = build(
      undefined,
      jest.fn().mockRejectedValue(new Error('No pickup address configured')),
    );
    const result = await service.pushOrderToShiprocketIfNeeded(
      baseOrder() as never,
    );
    expect(result).toEqual({});
    expect(shiprocketService.createOrder).not.toHaveBeenCalled();
  });
});

describe('OrdersService.syncTrackingFields', () => {
  const build = () => {
    const prisma = { order: { update: jest.fn().mockResolvedValue({}) } };
    const service = new OrdersService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
    return { service, prisma };
  };

  it('writes back awb and courier when Shiprocket has them', async () => {
    const { service, prisma } = build();
    await service.syncTrackingFields('order-1', {
      awb_code: 'AWB123',
      courier: 'Delhivery',
    });
    expect(prisma.order.update).toHaveBeenCalledWith({
      where: { id: 'order-1' },
      data: { awbCode: 'AWB123', courierName: 'Delhivery' },
    });
  });

  it('does not write anything when Shiprocket has not assigned them yet', async () => {
    const { service, prisma } = build();
    await service.syncTrackingFields('order-1', {
      awb_code: null,
      courier: null,
    });
    expect(prisma.order.update).not.toHaveBeenCalled();
  });

  it('never throws if the write fails', async () => {
    const prisma = {
      order: { update: jest.fn().mockRejectedValue(new Error('db down')) },
    };
    const service = new OrdersService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
    await expect(
      service.syncTrackingFields('order-1', { awb_code: 'AWB1' }),
    ).resolves.toBeUndefined();
  });
});

describe('OrdersService.notifyBuyerOfStatusChange', () => {
  const buildNotifyDeps = (
    shipment: { trackingUrl: string | null; courierName: string | null } | null = null,
  ) => {
    // The status email looks up the courier link for itself; unset by default
    // so the tests that predate it still describe a shipment with no link.
    const prisma = {
      order: { findUnique: jest.fn().mockResolvedValue(shipment) },
    };
    const mailService = { sendMail: jest.fn().mockResolvedValue({ sent: true, retryable: false }), resolveAdminRecipient: jest.fn(async () => process.env.ADMIN_NOTIFICATION_EMAIL?.trim() || process.env.SMTP_USER?.trim() || undefined) };
    const notificationsService = {
      notifyOrderDispatched: jest.fn().mockResolvedValue(undefined),
      notifyOrderShipped: jest.fn().mockResolvedValue(undefined),
      notifyOrderOutForDelivery: jest.fn().mockResolvedValue(undefined),
      notifyOrderDelivered: jest.fn().mockResolvedValue(undefined),
    };
    const otpSmsService = {
      sendTransactional: jest.fn().mockResolvedValue({ success: true }),
    };
    const service = new OrdersService(
      prisma as never,
      {} as never,
      mailService as never,
      notificationsService as never,
      otpSmsService as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { service, prisma, mailService, notificationsService, otpSmsService };
  };

  const order = {
    id: 'order-abc12345',
    buyerId: 'buyer-1',
    buyer: { email: 'buyer@example.com', phone: '9000000000' },
  };

  it('fires in-app, email, and SMS for a status the buyer cares about', async () => {
    const { service, mailService, notificationsService, otpSmsService } =
      buildNotifyDeps();

    await service.notifyBuyerOfStatusChange(order, OrderStatus.SHIPPED);

    expect(notificationsService.notifyOrderShipped).toHaveBeenCalledWith(
      'buyer-1',
      'order-abc12345',
    );
    expect(mailService.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'buyer@example.com' }),
    );
    expect(otpSmsService.sendTransactional).toHaveBeenCalledWith(
      '9000000000',
      expect.stringContaining('Shipped'),
    );
  });

  it('does nothing for a status the buyer does not need notifying about', async () => {
    const { service, mailService, notificationsService, otpSmsService } =
      buildNotifyDeps();

    await service.notifyBuyerOfStatusChange(order, OrderStatus.ACCEPTED);

    expect(mailService.sendMail).not.toHaveBeenCalled();
    expect(otpSmsService.sendTransactional).not.toHaveBeenCalled();
    expect(notificationsService.notifyOrderShipped).not.toHaveBeenCalled();
  });

  it('skips email when the buyer has none, but still sends SMS', async () => {
    const { service, mailService, otpSmsService } = buildNotifyDeps();

    await service.notifyBuyerOfStatusChange(
      { ...order, buyer: { email: null, phone: '9000000000' } },
      OrderStatus.OUT_FOR_DELIVERY,
    );

    expect(mailService.sendMail).not.toHaveBeenCalled();
    expect(otpSmsService.sendTransactional).toHaveBeenCalled();
  });

  it('never throws if a channel fails - one bad channel must not block the others', async () => {
    const { service, mailService, notificationsService, otpSmsService } =
      buildNotifyDeps();
    notificationsService.notifyOrderDelivered.mockRejectedValue(
      new Error('db down'),
    );
    mailService.sendMail.mockResolvedValue({ sent: false, retryable: true });
    otpSmsService.sendTransactional.mockResolvedValue({
      success: false,
      reason: 'not-configured',
    });

    await expect(
      service.notifyBuyerOfStatusChange(order, OrderStatus.DELIVERED),
    ).resolves.toBeUndefined();
  });

  /**
   * The buyer used to be told their order had shipped and then sent looking
   * for the link themselves, while the ADMIN email carried it. These pin the
   * link into the buyer's own mail — and pin it OUT of the SMS, which goes
   * against a DLT-approved template that must not gain a URL.
   */
  describe('with a courier link on the order', () => {
    const shipment = {
      trackingUrl: 'https://track.delhivery.com/p/ABC123',
      courierName: 'Delhivery',
    };

    it('puts the link and the courier in the shipped email', async () => {
      const { service, mailService } = buildNotifyDeps(shipment);

      await service.notifyBuyerOfStatusChange(order, OrderStatus.SHIPPED);

      const sent = mailService.sendMail.mock.calls[0][0];
      expect(sent.text).toContain('https://track.delhivery.com/p/ABC123');
      expect(sent.text).toContain('Delhivery');
      expect(sent.html).toContain('href="https://track.delhivery.com/p/ABC123"');
    });

    it('leaves the SMS wording exactly as the DLT template has it', async () => {
      const { service, otpSmsService } = buildNotifyDeps(shipment);

      await service.notifyBuyerOfStatusChange(order, OrderStatus.SHIPPED);

      const [, message] = otpSmsService.sendTransactional.mock.calls[0];
      expect(message).toBe(
        'Your Yukizi order #ORDER-AB is now Shipped. Track it in the Yukizi app.',
      );
      expect(message).not.toContain('http');
    });

    it('keeps the old wording when there is no link yet', async () => {
      const { service, mailService } = buildNotifyDeps(null);

      await service.notifyBuyerOfStatusChange(order, OrderStatus.SHIPPED);

      const sent = mailService.sendMail.mock.calls[0][0];
      expect(sent.text).toContain('You can track it anytime from the Orders section');
      expect(sent.text).not.toContain('Track your parcel');
    });

    it('does not chase a link for an order that has already been delivered', async () => {
      const { service, prisma, mailService } = buildNotifyDeps(shipment);

      await service.notifyBuyerOfStatusChange(order, OrderStatus.DELIVERED);

      expect(prisma.order.findUnique).not.toHaveBeenCalled();
      expect(mailService.sendMail.mock.calls[0][0].text).not.toContain(
        'Track your parcel',
      );
    });

    it('still emails the buyer when the tracking lookup fails', async () => {
      const { service, prisma, mailService } = buildNotifyDeps(shipment);
      prisma.order.findUnique.mockRejectedValue(new Error('connection lost'));

      await expect(
        service.notifyBuyerOfStatusChange(order, OrderStatus.SHIPPED),
      ).resolves.toBeUndefined();

      expect(mailService.sendMail).toHaveBeenCalled();
    });

    it('escapes a courier name a seller typed', async () => {
      const { service, mailService } = buildNotifyDeps({
        trackingUrl: null,
        courierName: '<script>alert(1)</script>',
      });

      await service.notifyBuyerOfStatusChange(order, OrderStatus.SHIPPED);

      const sent = mailService.sendMail.mock.calls[0][0];
      expect(sent.html).not.toContain('<script>');
      expect(sent.html).toContain('&lt;script&gt;');
    });
  });
});

describe('OrdersService.createSettlementsForDeliveredOrder', () => {
  const buildForSettlements = () => {
    const prisma = {
      sellerSettlement: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
      },
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
    };
    const service = new OrdersService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { service, prisma };
  };

  const item = (over: Record<string, unknown> = {}) => ({
    id: 'item-1',
    sellerId: 'seller-1',
    unitPrice: 100,
    quantity: 2,
    sellerOffer: {
      finalShippingPrice: null,
      shippingCharges: null,
      variant: { catalogProduct: { commissionPercent: 10, commissionGstPercent: 18 } },
    },
    ...over,
  });

  it('does nothing if the order is not DELIVERED', async () => {
    const { service, prisma } = buildForSettlements();
    await service.createSettlementsForDeliveredOrder({
      orderStatus: OrderStatus.SHIPPED,
      paymentStatus: 'SUCCESS' as never,
      items: [item()],
    });
    expect(prisma.sellerSettlement.create).not.toHaveBeenCalled();
  });

  it('does nothing if payment is not SUCCESS', async () => {
    const { service, prisma } = buildForSettlements();
    await service.createSettlementsForDeliveredOrder({
      orderStatus: OrderStatus.DELIVERED,
      paymentStatus: 'PENDING' as never,
      items: [item()],
    });
    expect(prisma.sellerSettlement.create).not.toHaveBeenCalled();
  });

  it('creates a settlement per item when DELIVERED and paid', async () => {
    const { service, prisma } = buildForSettlements();
    await service.createSettlementsForDeliveredOrder({
      orderStatus: OrderStatus.DELIVERED,
      paymentStatus: 'SUCCESS' as never,
      items: [item()],
    });
    expect(prisma.sellerSettlement.create).toHaveBeenCalledTimes(1);
    // unitPrice 100 * qty 2 = gross 200; commission 10% = 20; commissionGst 18% of 20 = 3.6;
    // netPayout = 200 - 20 - 3.6 - 0(shipping) = 176.4
    expect(prisma.sellerSettlement.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sellerId: 'seller-1',
          orderItemId: 'item-1',
          grossAmount: '200',
          commission: '20',
          commissionGst: '3.6',
          netPayout: '176.4',
        }),
      }),
    );
  });

  it('skips an item that already has a settlement (idempotent)', async () => {
    const { service, prisma } = buildForSettlements();
    prisma.sellerSettlement.findUnique.mockResolvedValue({ id: 'existing' });
    await service.createSettlementsForDeliveredOrder({
      orderStatus: OrderStatus.DELIVERED,
      paymentStatus: 'SUCCESS' as never,
      items: [item()],
    });
    expect(prisma.sellerSettlement.create).not.toHaveBeenCalled();
  });
});

describe('OrdersService.checkout — price integrity', () => {
  const cartItem = (overrides: Partial<any> = {}) => ({
    id: 'cartitem-1',
    sellerOfferId: 'offer-1', // flat scalar CartItem.sellerOfferId, separate from the nested sellerOffer relation below — orderItemsData reads this directly
    quantity: 2,
    unitPrice: 50, // stale snapshot from whenever the item was added to cart
    sellerOffer: {
      id: 'offer-1',
      name: 'Test Product',
      isActive: true,
      deletedAt: null,
      mrp: 100,
      finalCustomerPayable: 80, // the seller's CURRENT price — different from unitPrice above
      seller: { id: 'seller-1', verificationStatus: 'APPROVED', companyName: 'Acme' },
      batches: [{ id: 'batch-1', stock: 10, expiryDate: new Date('2099-01-01') }],
      ...overrides,
    },
  });

  const buildCheckout = (items: any[]) => {
    const txOrderItemCreateManyCalls: any[] = [];
    const tx = {
      order: { create: jest.fn().mockResolvedValue({ id: 'order-1' }) },
      orderItem: {
        createMany: jest.fn().mockImplementation((args: any) => {
          txOrderItemCreateManyCalls.push(args);
          return Promise.resolve({ count: args.data.length });
        }),
      },
      orderAddress: { create: jest.fn().mockResolvedValue({}) },
      productBatch: { update: jest.fn().mockResolvedValue({}) },
      cartItem: { deleteMany: jest.fn().mockResolvedValue({ count: items.length }) },
    };
    const prisma = {
      // checkout() checks the typed contact details against other accounts
      // before it touches the cart. Nothing is held by anyone else here.
      user: {
        findUnique: jest.fn().mockResolvedValue({ phone: '9008336683', email: 'buyer@example.com' }),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      cart: {
        findUnique: jest.fn().mockResolvedValue({ id: 'cart-1', items }),
      },
      buyerProfile: {
        findUnique: jest.fn().mockResolvedValue({ referralCodeId: null }),
      },
      $transaction: jest.fn().mockImplementation((cb: any) => cb(tx)),
      // checkout()'s final "5. Fetch the created order with full details" step
      // (orders.service.ts:592) runs after the transaction, unwrapped in any
      // try/catch — items: [] keeps its follow-up per-item catalogProduct
      // lookup loop a no-op, so no further prisma.catalogProduct mock is needed.
      order: {
        findUnique: jest.fn().mockResolvedValue({ id: 'order-1', items: [] }),
      },
    };
    const service = new OrdersService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { service, prisma, tx, txOrderItemCreateManyCalls };
  };

  // deferSellerNotification: true skips checkout()'s post-transaction
  // this.sellerOrderNotifier.notifySellersOfNewOrder(...) call entirely (see
  // orders.service.ts's "4f. Notify each seller" block) — needed here because
  // this test's OrdersService is built with sellerOrderNotifier as `{} as
  // never`; without this flag, checkout() would call a method that doesn't
  // exist on `{}` and throw synchronously (not something a `.catch()` further
  // down the chain could ever reach, since the call itself never returns).
  const checkoutDto = () => dto({ deferSellerNotification: true } as never);

  it('charges the live seller price, not the cart item\'s stale unitPrice snapshot', async () => {
    const { service, txOrderItemCreateManyCalls } = buildCheckout([cartItem()]);

    await service.checkout('buyer-1', checkoutDto());

    const created = txOrderItemCreateManyCalls[0].data[0];
    expect(created.unitPrice).toBe(80); // live finalCustomerPayable, not the stale 50
    expect(created.totalPrice).toBe(160); // 2 * 80, not 2 * 50
  });

  it('falls back to live mrp when finalCustomerPayable is null', async () => {
    const { service, txOrderItemCreateManyCalls } = buildCheckout([
      cartItem({ finalCustomerPayable: null }),
    ]);

    await service.checkout('buyer-1', checkoutDto());

    expect(txOrderItemCreateManyCalls[0].data[0].unitPrice).toBe(100);
  });

  it('still rejects a deactivated offer before any price recompute', async () => {
    const { service } = buildCheckout([cartItem({ isActive: false })]);

    await expect(service.checkout('buyer-1', checkoutDto())).rejects.toThrow(
      'Product "Test Product" is no longer available. Please remove it from your cart.',
    );
  });
});


describe('OrdersService.updateShippingDetails — auto-accept + Shiprocket push', () => {
  const ORIGINAL_ADMIN_EMAIL = process.env.ADMIN_NOTIFICATION_EMAIL;
  const ORIGINAL_SMTP_USER = process.env.SMTP_USER;

  afterEach(() => {
    if (ORIGINAL_ADMIN_EMAIL === undefined) {
      delete process.env.ADMIN_NOTIFICATION_EMAIL;
    } else {
      process.env.ADMIN_NOTIFICATION_EMAIL = ORIGINAL_ADMIN_EMAIL;
    }
    if (ORIGINAL_SMTP_USER === undefined) {
      delete process.env.SMTP_USER;
    } else {
      process.env.SMTP_USER = ORIGINAL_SMTP_USER;
    }
  });

  const build = ({ updatedCount = 1 } = {}) => {
    const prisma = {
      sellerProfile: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'seller-1', userId: 'user-1', companyName: 'Acme Co' }),
      },
      orderItem: {
        findMany: jest.fn().mockResolvedValue([{ id: 'item-1', isShippingLocked: false }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      order: {
        update: jest.fn().mockResolvedValue({ id: 'order-1' }),
        updateMany: jest.fn().mockResolvedValue({ count: updatedCount }),
        findUnique: jest.fn().mockResolvedValue({
          id: 'order-1',
          buyerId: 'buyer-1',
          paymentStatus: 'SUCCESS',
          buyer: { email: 'b@x.com', phone: '9999999999' },
          address: null,
          items: [],
        }),
      },
    };
    const mailService = {
      sendMail: jest.fn().mockResolvedValue({ sent: true, retryable: false }), resolveAdminRecipient: jest.fn(async () => process.env.ADMIN_NOTIFICATION_EMAIL?.trim() || process.env.SMTP_USER?.trim() || undefined),
    };
    const service = new OrdersService(
      prisma as never,
      {} as never,
      mailService as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const notifySpy = jest
      .spyOn(service, 'notifyBuyerOfStatusChange')
      .mockResolvedValue(undefined);
    const pushSpy = jest
      .spyOn(service, 'pushOrderToShiprocketIfNeeded')
      .mockResolvedValue({ shiprocketOrderId: 'sr-1', shipmentId: 'ship-1' });
    return { service, prisma, mailService, notifySpy, pushSpy };
  };

  const dto = { packageWeight: 2 } as never;

  it('rejects shipping details on an unpaid order (sellers can see but not accept them)', async () => {
    const { service, prisma } = build();
    prisma.order.findUnique.mockResolvedValueOnce({ paymentStatus: 'PENDING' });

    await expect(
      service.updateShippingDetails('user-1', 'order-1', dto),
    ).rejects.toThrow('has not been paid yet');
    expect(prisma.orderItem.updateMany).not.toHaveBeenCalled();
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
  });

  it('advances a PLACED order to ACCEPTED with a status-guarded write and notifies the buyer', async () => {
    const { service, prisma, notifySpy } = build();
    await service.updateShippingDetails('user-1', 'order-1', dto);

    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'order-1', orderStatus: OrderStatus.PLACED },
      data: { orderStatus: OrderStatus.ACCEPTED },
    });
    expect(notifySpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'order-1' }),
      OrderStatus.ACCEPTED,
    );
  });

  it('pushes the order to Shiprocket and persists the returned identifiers', async () => {
    const { service, prisma, pushSpy } = build();
    await service.updateShippingDetails('user-1', 'order-1', dto);

    expect(pushSpy).toHaveBeenCalled();
    expect(prisma.order.update).toHaveBeenCalledWith({
      where: { id: 'order-1' },
      data: { shiprocketOrderId: 'sr-1', shipmentId: 'ship-1' },
    });
  });

  it('does not notify when the guarded accept write loses (order no longer PLACED) but still pushes', async () => {
    const { service, notifySpy, pushSpy } = build({ updatedCount: 0 });
    await service.updateShippingDetails('user-1', 'order-1', dto);

    expect(notifySpy).not.toHaveBeenCalled();
    expect(pushSpy).toHaveBeenCalled();
  });

  it('skips the extra persist when the push no-ops (already pushed / failed)', async () => {
    const { service, prisma, pushSpy } = build();
    pushSpy.mockResolvedValue({});
    await service.updateShippingDetails('user-1', 'order-1', dto);

    const persistCalls = prisma.order.update.mock.calls.filter(
      (c: any[]) => c[0]?.data?.shiprocketOrderId,
    );
    expect(persistCalls).toHaveLength(0);
  });

  it('never lets an auto-accept/push failure break the shipping-details save itself', async () => {
    const { service, pushSpy } = build();
    pushSpy.mockRejectedValue(new Error('shiprocket down'));
    await expect(
      service.updateShippingDetails('user-1', 'order-1', dto),
    ).resolves.toEqual({ id: 'order-1' });
  });

  describe('admin notification email', () => {
    it('emails ADMIN_NOTIFICATION_EMAIL when it is configured', async () => {
      process.env.ADMIN_NOTIFICATION_EMAIL = 'admin@yukizi.com';
      const { service, mailService } = build();

      await service.updateShippingDetails('user-1', 'order-1', dto);

      expect(mailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'admin@yukizi.com',
          subject: expect.stringContaining('ORDER-1'),
          text: expect.stringContaining('Acme Co'),
        }),
      );
    });

    it('falls back to SMTP_USER when ADMIN_NOTIFICATION_EMAIL is not set', async () => {
      delete process.env.ADMIN_NOTIFICATION_EMAIL;
      process.env.SMTP_USER = 'platform-inbox@yukizi.com';
      const { service, mailService } = build();

      await service.updateShippingDetails('user-1', 'order-1', dto);

      expect(mailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'platform-inbox@yukizi.com' }),
      );
    });

    it('skips silently when neither ADMIN_NOTIFICATION_EMAIL nor SMTP_USER is set', async () => {
      delete process.env.ADMIN_NOTIFICATION_EMAIL;
      delete process.env.SMTP_USER;
      const { service, mailService } = build();

      await service.updateShippingDetails('user-1', 'order-1', dto);

      expect(mailService.sendMail).not.toHaveBeenCalled();
    });

    it('never lets a failed admin-notification send break the shipping-details save', async () => {
      process.env.ADMIN_NOTIFICATION_EMAIL = 'admin@yukizi.com';
      const { service, mailService } = build();
      mailService.sendMail.mockResolvedValue({ sent: false, retryable: true });

      await expect(
        service.updateShippingDetails('user-1', 'order-1', dto),
      ).resolves.toEqual({ id: 'order-1' });
    });
  });
});

describe('OrdersService.updateAdminShippingDocs', () => {
  const buildAdmin = (
    items: { id: string; sellerId: string; packageLength: number | null }[] = [
      { id: 'item-1', sellerId: 'seller-1', packageLength: 10 },
    ],
  ) => {
    const prisma = {
      order: {
        findUnique: jest.fn().mockResolvedValue({ id: 'order-1', items, packageLength: null }),
        update: jest.fn().mockResolvedValue({}),
      },
      orderItem: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const sellerOrderNotifier = {
      notifySellersDocsReady: jest.fn().mockResolvedValue(undefined),
    };
    const service = new OrdersService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      sellerOrderNotifier as never,
      {} as never,
      {} as never,
    );
    return { service, prisma, sellerOrderNotifier };
  };

  it('notifies the scoped seller when a document URL is uploaded for them', async () => {
    const { service, sellerOrderNotifier } = buildAdmin();

    await service.updateAdminShippingDocs('order-1', {
      sellerId: 'seller-1',
      adminShippingLabelUrl: 'https://cdn.example.com/label.pdf',
    });

    expect(sellerOrderNotifier.notifySellersDocsReady).toHaveBeenCalledWith([
      { orderId: 'order-1', sellerId: 'seller-1' },
    ]);
  });

  it('notifies every seller on the order when all have package details and no sellerId scope is given', async () => {
    const items = [
      { id: 'item-1', sellerId: 'seller-1', packageLength: 10 },
      { id: 'item-2', sellerId: 'seller-2', packageLength: 5 },
    ];
    const { service, sellerOrderNotifier } = buildAdmin(items);

    await service.updateAdminShippingDocs('order-1', {
      manifestUrl: 'https://cdn.example.com/manifest.pdf',
    });

    expect(sellerOrderNotifier.notifySellersDocsReady).toHaveBeenCalledWith([
      { orderId: 'order-1', sellerId: 'seller-1' },
      { orderId: 'order-1', sellerId: 'seller-2' },
    ]);
  });

  it('only notifies sellers whose items actually got the document, not every seller on the order', async () => {
    // seller-2 has no packageLength yet, so the doc-URL write only touches
    // seller-1's OrderItem rows (see the itemsWithPackage branch) - seller-2
    // must not be told documents are ready when their own items were never
    // updated with them.
    const items = [
      { id: 'item-1', sellerId: 'seller-1', packageLength: 10 },
      { id: 'item-2', sellerId: 'seller-2', packageLength: null },
    ];
    const { service, sellerOrderNotifier } = buildAdmin(items);

    await service.updateAdminShippingDocs('order-1', {
      manifestUrl: 'https://cdn.example.com/manifest.pdf',
    });

    expect(sellerOrderNotifier.notifySellersDocsReady).toHaveBeenCalledWith([
      { orderId: 'order-1', sellerId: 'seller-1' },
    ]);
  });

  it('does not notify on a lock-only toggle with no document URL', async () => {
    const { service, sellerOrderNotifier } = buildAdmin();

    await service.updateAdminShippingDocs('order-1', {
      sellerId: 'seller-1',
      isShippingLocked: true,
    });

    expect(sellerOrderNotifier.notifySellersDocsReady).not.toHaveBeenCalled();
  });
});

describe('OrdersService.cancelOrder', () => {
  const build = (
    order: {
      buyerId?: string;
      orderStatus?: OrderStatus;
      paymentStatus?: PaymentStatus;
    } = {},
    // Lets a test simulate a payment confirming in the gap between the
    // initial read and the guarded transactional write, by controlling how
    // many rows the guarded updateMany reports as matched.
    guardedUpdateCount = 1,
  ) => {
    const prisma = {
      order: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'order-1',
          buyerId: order.buyerId ?? 'buyer-1',
          orderStatus: order.orderStatus ?? OrderStatus.PLACED,
          paymentStatus: order.paymentStatus ?? PaymentStatus.PENDING,
          items: [],
        }),
        updateMany: jest.fn().mockResolvedValue({ count: guardedUpdateCount }),
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ id: 'order-1', orderStatus: OrderStatus.CANCELLED }),
      },
      $transaction: jest.fn().mockImplementation((cb: any) => cb(prisma)),
    };
    const service = new OrdersService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { service, prisma };
  };

  const paidGuardWhere = {
    id: 'order-1',
    paymentStatus: { notIn: [PaymentStatus.SUCCESS, PaymentStatus.PARTIAL] },
  };

  it('cancels an unpaid PLACED order and restores stock', async () => {
    const { service, prisma } = build();

    await service.cancelOrder('buyer-1', 'order-1', Role.BUYER);

    // The cancellation reason and timestamp are written in this same guarded
    // statement, so an order can never be cancelled without a record of why.
    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: paidGuardWhere,
      data: {
        orderStatus: OrderStatus.CANCELLED,
        cancellationReason: null,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        cancelledAt: expect.any(Date),
      },
    });
  });

  it('refuses to cancel an order that has already been paid for, even for its own buyer', async () => {
    const { service, prisma } = build({ paymentStatus: PaymentStatus.SUCCESS });

    await expect(
      service.cancelOrder('buyer-1', 'order-1', Role.BUYER),
    ).rejects.toThrow('This order has a confirmed payment');
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
  });

  it('refuses to cancel a paid order for an admin caller too', async () => {
    const { service, prisma } = build({ paymentStatus: PaymentStatus.SUCCESS });

    await expect(
      service.cancelOrder('admin-1', 'order-1', Role.ADMIN),
    ).rejects.toThrow('This order has a confirmed payment');
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
  });

  it('refuses to cancel a PARTIAL-payment order — that represents real confirmed money, not "unpaid yet"', async () => {
    const { service, prisma } = build({ paymentStatus: PaymentStatus.PARTIAL });

    await expect(
      service.cancelOrder('buyer-1', 'order-1', Role.BUYER),
    ).rejects.toThrow('This order has a confirmed payment');
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
  });

  it('still rejects an already-cancelled order before the payment check would even matter', async () => {
    const { service } = build({ orderStatus: OrderStatus.CANCELLED });

    await expect(
      service.cancelOrder('buyer-1', 'order-1', Role.BUYER),
    ).rejects.toThrow('Cannot cancel order in CANCELLED status');
  });

  it('aborts if the payment gets confirmed in the gap between the read and the guarded write', async () => {
    // Initial read still sees PENDING (so it passes the first guard), but
    // the guarded updateMany matches zero rows - as it would if a separate
    // PaymentsService.confirmPayment transaction committed SUCCESS/PARTIAL
    // in between. Nothing after the guarded write must run.
    const { service, prisma } = build({ paymentStatus: PaymentStatus.PENDING }, 0);

    await expect(
      service.cancelOrder('buyer-1', 'order-1', Role.BUYER),
    ).rejects.toThrow('This order has a confirmed payment');
    expect(prisma.order.findUniqueOrThrow).not.toHaveBeenCalled();
  });
});

describe('OrdersService.checkout — fulfillmentMode snapshot', () => {
  const cartItem = (seller: Partial<any> = {}) => ({
    id: 'cartitem-1',
    sellerOfferId: 'offer-1',
    quantity: 1,
    unitPrice: 50,
    sellerOffer: {
      id: 'offer-1',
      name: 'Test Product',
      isActive: true,
      deletedAt: null,
      mrp: 100,
      finalCustomerPayable: 80,
      seller: {
        id: 'seller-1',
        verificationStatus: 'APPROVED',
        companyName: 'Acme',
        selfShipEnabled: false,
        ...seller,
      },
      batches: [{ id: 'batch-1', stock: 10, expiryDate: new Date('2099-01-01') }],
    },
  });

  const buildCheckout = (items: any[]) => {
    const orderCreateCalls: any[] = [];
    const tx = {
      order: {
        create: jest.fn().mockImplementation((args: any) => {
          orderCreateCalls.push(args);
          return Promise.resolve({ id: 'order-1' });
        }),
      },
      orderItem: {
        createMany: jest.fn().mockResolvedValue({ count: items.length }),
      },
      orderAddress: { create: jest.fn().mockResolvedValue({}) },
      productBatch: { update: jest.fn().mockResolvedValue({}) },
      cartItem: { deleteMany: jest.fn().mockResolvedValue({ count: items.length }) },
    };
    const prisma = {
      // checkout() checks the typed contact details against other accounts
      // before it touches the cart. Nothing is held by anyone else here.
      user: {
        findUnique: jest.fn().mockResolvedValue({ phone: '9008336683', email: 'buyer@example.com' }),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      cart: { findUnique: jest.fn().mockResolvedValue({ id: 'cart-1', items }) },
      buyerProfile: { findUnique: jest.fn().mockResolvedValue({ referralCodeId: null }) },
      $transaction: jest.fn().mockImplementation((cb: any) => cb(tx)),
      order: { findUnique: jest.fn().mockResolvedValue({ id: 'order-1', items: [] }) },
    };
    const service = new OrdersService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { service, orderCreateCalls };
  };

  const checkoutDto = () => dto({ deferSellerNotification: true } as never);

  it("snapshots 'self_ship' when the seller has selfShipEnabled at checkout", async () => {
    const { service, orderCreateCalls } = buildCheckout([
      cartItem({ selfShipEnabled: true }),
    ]);

    await service.checkout('buyer-1', checkoutDto());

    expect(orderCreateCalls[0].data.fulfillmentMode).toBe('self_ship');
  });

  it("defaults to 'shiprocket' when the seller flag is off", async () => {
    const { service, orderCreateCalls } = buildCheckout([cartItem()]);

    await service.checkout('buyer-1', checkoutDto());

    expect(orderCreateCalls[0].data.fulfillmentMode).toBe('shiprocket');
  });
});

describe('OrdersService self-ship guards on the Shiprocket flow', () => {
  const buildService = (prisma: any = {}, shiprocket: any = {}) =>
    new OrdersService(
      prisma as never,
      shiprocket as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

  it('pushOrderToShiprocketIfNeeded no-ops for a self_ship order', async () => {
    const shiprocket = {
      getPrimaryPickupLocation: jest.fn(),
      createOrder: jest.fn(),
    };
    const service = buildService({}, shiprocket);

    const result = await service.pushOrderToShiprocketIfNeeded({
      id: 'order-1',
      createdAt: new Date(),
      totalAmount: 100,
      paymentStatus: PaymentStatus.SUCCESS,
      shiprocketOrderId: null,
      fulfillmentMode: 'self_ship',
      address: null,
      buyer: {},
      items: [],
    });

    expect(result).toEqual({});
    expect(shiprocket.getPrimaryPickupLocation).not.toHaveBeenCalled();
    expect(shiprocket.createOrder).not.toHaveBeenCalled();
  });

  it('updateShippingDetails rejects a self_ship order before writing anything', async () => {
    const prisma = {
      sellerProfile: { findUnique: jest.fn().mockResolvedValue({ id: 'seller-1' }) },
      orderItem: {
        findMany: jest.fn().mockResolvedValue([{ id: 'item-1', isShippingLocked: false }]),
        updateMany: jest.fn(),
      },
      order: {
        findUnique: jest.fn().mockResolvedValue({
          paymentStatus: PaymentStatus.SUCCESS,
          fulfillmentMode: 'self_ship',
        }),
        update: jest.fn(),
      },
    };
    const service = buildService(prisma);

    await expect(
      service.updateShippingDetails('user-1', 'order-1', { packageWeight: 1 } as never),
    ).rejects.toThrow('self-ship fulfillment');
    expect(prisma.orderItem.updateMany).not.toHaveBeenCalled();
    expect(prisma.order.update).not.toHaveBeenCalled();
  });

  it('updateAdminShippingDocs rejects a self_ship order before writing anything', async () => {
    const prisma = {
      order: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'order-1',
          fulfillmentMode: 'self_ship',
          items: [{ sellerId: 'seller-1', packageLength: 10 }],
        }),
        update: jest.fn(),
      },
      orderItem: { updateMany: jest.fn() },
    };
    const service = buildService(prisma);

    await expect(
      service.updateAdminShippingDocs('order-1', { adminShippingLabelUrl: 'https://x/label.pdf' }),
    ).rejects.toThrow('self-ship fulfillment');
    expect(prisma.order.update).not.toHaveBeenCalled();
    expect(prisma.orderItem.updateMany).not.toHaveBeenCalled();
  });
});

describe('OrdersService.syncTrackingFields — track_url', () => {
  it('persists the Shiprocket tracking URL alongside awb/courier', async () => {
    const prisma = { order: { update: jest.fn().mockResolvedValue({}) } };
    const service = new OrdersService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await service.syncTrackingFields('order-1', {
      awb_code: 'AWB123',
      courier: 'Delhivery',
      track_url: 'https://shiprocket.co/tracking/AWB123',
    });

    expect(prisma.order.update).toHaveBeenCalledWith({
      where: { id: 'order-1' },
      data: {
        awbCode: 'AWB123',
        courierName: 'Delhivery',
        trackingUrl: 'https://shiprocket.co/tracking/AWB123',
      },
    });
  });
});

describe('OrdersService.submitSelfShipTracking', () => {
  const buildSubmit = (orderOver: Partial<any> = {}, opts: { sellerItems?: any[] } = {}) => {
    const prisma = {
      sellerProfile: { findUnique: jest.fn().mockResolvedValue({ id: 'seller-1' }) },
      orderItem: {
        findMany: jest.fn().mockResolvedValue(
          opts.sellerItems ?? [{ id: 'item-1' }],
        ),
      },
      order: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'order-1',
          buyerId: 'buyer-1',
          fulfillmentMode: 'self_ship',
          paymentStatus: PaymentStatus.SUCCESS,
          orderStatus: OrderStatus.PLACED,
          shippedAt: null,
          buyer: { email: 'b@x.com', phone: '9999999999' },
          ...orderOver,
        }),
        update: jest.fn().mockResolvedValue({ id: 'order-1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const service = new OrdersService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const notifySpy = jest
      .spyOn(service, 'notifyBuyerOfStatusChange')
      .mockResolvedValue(undefined);
    return { service, prisma, notifySpy };
  };

  const trackingDto = { trackingUrl: 'https://courier.example/track/123' };

  it('rejects an order whose mode is not self_ship', async () => {
    const { service, prisma } = buildSubmit({ fulfillmentMode: 'shiprocket' });

    await expect(
      service.submitSelfShipTracking('user-1', 'order-1', trackingDto),
    ).rejects.toThrow('self-ship tracking does not apply');
    expect(prisma.order.update).not.toHaveBeenCalled();
  });

  it('rejects when the buyer has not paid yet', async () => {
    const { service, prisma } = buildSubmit({ paymentStatus: PaymentStatus.PENDING });

    await expect(
      service.submitSelfShipTracking('user-1', 'order-1', trackingDto),
    ).rejects.toThrow('has not been paid yet');
    expect(prisma.order.update).not.toHaveBeenCalled();
  });

  it('rejects when the seller has no items in the order', async () => {
    const { service, prisma } = buildSubmit({}, { sellerItems: [] });

    await expect(
      service.submitSelfShipTracking('user-1', 'order-1', trackingDto),
    ).rejects.toThrow('do not have any items');
    expect(prisma.order.update).not.toHaveBeenCalled();
  });

  it('rejects a cancelled order', async () => {
    const { service } = buildSubmit({ orderStatus: OrderStatus.CANCELLED });

    await expect(
      service.submitSelfShipTracking('user-1', 'order-1', trackingDto),
    ).rejects.toThrow('can no longer be shipped');
  });

  it('first submit saves the link, stamps shippedAt, advances to SHIPPED and notifies the buyer', async () => {
    const { service, prisma, notifySpy } = buildSubmit();

    await service.submitSelfShipTracking('user-1', 'order-1', {
      ...trackingDto,
      courierName: 'BlueDart',
    });

    const updateData = prisma.order.update.mock.calls[0][0].data;
    expect(updateData.trackingUrl).toBe(trackingDto.trackingUrl);
    expect(updateData.courierName).toBe('BlueDart');
    expect(updateData.shippedAt).toBeInstanceOf(Date);

    expect(prisma.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'order-1' }),
        data: { orderStatus: OrderStatus.SHIPPED },
      }),
    );
    expect(notifySpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'order-1', buyerId: 'buyer-1' }),
      OrderStatus.SHIPPED,
    );
  });

  it('later submits only edit the link — no re-stamp, no status change, no notification', async () => {
    const { service, prisma, notifySpy } = buildSubmit({
      shippedAt: new Date('2026-08-01'),
      orderStatus: OrderStatus.SHIPPED,
    });

    await service.submitSelfShipTracking('user-1', 'order-1', {
      trackingUrl: 'https://courier.example/track/456',
    });

    const updateData = prisma.order.update.mock.calls[0][0].data;
    expect(updateData.trackingUrl).toBe('https://courier.example/track/456');
    expect(updateData.shippedAt).toBeUndefined();
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
    expect(notifySpy).not.toHaveBeenCalled();
  });

  it('does not notify when the guarded status advance loses to a concurrent change', async () => {
    const { service, prisma, notifySpy } = buildSubmit();
    prisma.order.updateMany.mockResolvedValue({ count: 0 });

    await service.submitSelfShipTracking('user-1', 'order-1', trackingDto);

    expect(notifySpy).not.toHaveBeenCalled();
  });
});

describe('OrdersService.submitSelfShipTracking — admin email', () => {
  const originalAdmin = process.env.ADMIN_NOTIFICATION_EMAIL;
  afterEach(() => {
    if (originalAdmin === undefined) delete process.env.ADMIN_NOTIFICATION_EMAIL;
    else process.env.ADMIN_NOTIFICATION_EMAIL = originalAdmin;
  });

  const build = (mailOverrides: Record<string, unknown> = {}) => {
    const order = {
      id: 'aaaabbbb-1111-2222-3333-444444444444',
      buyerId: 'buyer-1',
      fulfillmentMode: 'self_ship',
      paymentStatus: 'SUCCESS',
      orderStatus: 'ACCEPTED',
      shippedAt: null,
      buyer: { email: null, phone: null },
    };
    const prisma = {
      sellerProfile: { findUnique: jest.fn().mockResolvedValue({ id: 'seller-1', companyName: 'Acme Collectibles' }) },
      orderItem: { findMany: jest.fn().mockResolvedValue([{ id: 'oi-1' }]) },
      order: {
        findUnique: jest.fn().mockResolvedValue(order),
        update: jest.fn().mockResolvedValue({ ...order, trackingUrl: 'https://track/1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const mailService = {
      sendMail: jest.fn().mockResolvedValue({ sent: true, retryable: false }),
      resolveAdminRecipient: jest.fn().mockResolvedValue('admin@yukizi.com'),
      ...mailOverrides,
    };
    // mailService is the THIRD constructor arg (prisma, shiprocket, mail, …).
    const service = new OrdersService(
      prisma as never,
      {} as never,
      mailService as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { service, mailService, prisma };
  };

  it('emails the admin when a self-ship seller submits tracking', async () => {
    const { service, mailService } = build();

    await service.submitSelfShipTracking('user-1', 'aaaabbbb-1111-2222-3333-444444444444', {
      trackingUrl: 'https://track/1',
      courierName: 'Delhivery',
    } as never);

    expect(mailService.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'admin@yukizi.com' }),
    );
    const arg = mailService.sendMail.mock.calls[0][0] as { subject: string };
    expect(arg.subject).toContain('AAAABBBB');
  });

  it('never fails the tracking submission when the admin email throws', async () => {
    const { service } = build({
      sendMail: jest.fn().mockRejectedValue(new Error('smtp down')),
    });

    await expect(
      service.submitSelfShipTracking('user-1', 'aaaabbbb-1111-2222-3333-444444444444', {
        trackingUrl: 'https://track/1',
      } as never),
    ).resolves.toBeDefined();
  });
});

/**
 * A buyer typing contact details that belong to somebody else's account used
 * to have them silently ignored: the order went through, they were never
 * told, and their account stayed blank — which is also how their orders ended
 * up invisible in the admin. Now they are told, before anything is charged.
 */
describe('OrdersService.checkout — contact details already registered', () => {
  const buildGuard = (
    account: { phone?: string | null; email?: string | null },
    heldByOther: { phone?: boolean; email?: boolean } = {},
  ) => {
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          phone: account.phone ?? null,
          email: account.email ?? null,
        }),
        findFirst: jest.fn().mockImplementation(({ where }: any) =>
          Promise.resolve(
            (where.phone && heldByOther.phone) || (where.email && heldByOther.email)
              ? { id: 'someone-else' }
              : null,
          ),
        ),
      },
      cart: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    const service = new OrdersService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const guard = (
      service as unknown as {
        assertContactDetailsAreClaimable(u: string, d: CreateOrderDto): Promise<void>;
      }
    ).assertContactDetailsAreClaimable.bind(service);
    return { guard, prisma };
  };

  it('stops a phone-only conflict with a message naming what to do', async () => {
    // Signed in with Google: no phone on the account, and the number typed at
    // checkout belongs to somebody else.
    const { guard } = buildGuard({ phone: null, email: 'buyer@example.com' }, { phone: true });

    await expect(guard('user-1', dto())).rejects.toThrow(/already registered/i);
    await expect(guard('user-1', dto())).rejects.toThrow(/different number/i);
  });

  it('stops an email conflict for a buyer who signed in by phone', async () => {
    const { guard } = buildGuard({ phone: '9000000000', email: null }, { email: true });

    await expect(guard('user-1', dto())).rejects.toThrow(/different email/i);
  });

  it('lets the order through when nothing is held by anyone else', async () => {
    const { guard } = buildGuard({ phone: null, email: null });

    await expect(guard('user-1', dto())).resolves.toBeUndefined();
  });

  it('lets a buyer with their own number on file deliver to someone else', async () => {
    // Sending a gift to a friend: the friend's number is on their own account,
    // and that must keep working — nothing is being claimed here.
    const { guard, prisma } = buildGuard(
      { phone: '9111111111', email: 'buyer@example.com' },
      { phone: true, email: true },
    );

    await expect(guard('user-1', dto())).resolves.toBeUndefined();
    // Not even looked up: there is nothing to claim.
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });

  it('does not trip on the buyer re-entering their own details', async () => {
    const { guard } = buildGuard({ phone: '9008336683', email: 'buyer@example.com' });

    await expect(guard('user-1', dto())).resolves.toBeUndefined();
  });
});

/**
 * An admin can cancel an order, but nothing recorded why and nothing told the
 * buyer — their order simply changed state under them. These pin the reason
 * into the same guarded write as the status, so an order can never end up
 * cancelled with no record of why, and pin that telling the buyer can never
 * fail a cancellation that has already restored stock.
 */
describe('OrdersService.cancelOrder — reason and buyer notice', () => {
  const ORDER_ID = 'abaf6047-9999-8888-7777-666666666666';

  const buildCancel = () => {
    const tx = {
      order: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ id: ORDER_ID, orderStatus: 'CANCELLED' }),
      },
      productBatch: { update: jest.fn() },
      productWaitlist: { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn() },
    };
    const prisma = {
      order: {
        findUnique: jest.fn().mockResolvedValue({
          id: ORDER_ID,
          buyerId: 'buyer-1',
          orderStatus: 'PLACED',
          paymentStatus: 'PENDING',
          buyer: { email: 'buyer@example.com', phone: '9000000000' },
          items: [],
        }),
      },
      $transaction: jest.fn().mockImplementation((cb: any) => cb(tx)),
    };
    const notificationsService = {
      notifyOrderCancelled: jest.fn().mockResolvedValue(undefined),
    };
    const mailService = { sendMail: jest.fn().mockResolvedValue({ sent: true }) };
    const otpSmsService = { sendTransactional: jest.fn().mockResolvedValue({ success: true }) };
    const service = new OrdersService(
      prisma as never,
      {} as never,
      mailService as never,
      notificationsService as never,
      otpSmsService as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { service, prisma, tx, notificationsService, mailService, otpSmsService };
  };

  const flush = () => new Promise((r) => setImmediate(r));

  it('writes the reason in the same statement as the cancelled status', async () => {
    const { service, tx } = buildCancel();

    await service.cancelOrder('admin-1', ORDER_ID, 'ADMIN', 'Item out of stock at the seller');

    const write = tx.order.updateMany.mock.calls[0][0].data;
    expect(write.orderStatus).toBe('CANCELLED');
    expect(write.cancellationReason).toBe('Item out of stock at the seller');
    expect(write.cancelledAt).toBeInstanceOf(Date);
  });

  it('stores null rather than an empty string when no reason is given', async () => {
    const { service, tx } = buildCancel();

    await service.cancelOrder('buyer-1', ORDER_ID, 'BUYER');

    expect(tx.order.updateMany.mock.calls[0][0].data.cancellationReason).toBeNull();
  });

  it('tells the buyer, with the reason, on all three channels', async () => {
    const { service, notificationsService, mailService, otpSmsService } = buildCancel();

    await service.cancelOrder('admin-1', ORDER_ID, 'ADMIN', 'Seller could not fulfil');
    await flush();

    expect(notificationsService.notifyOrderCancelled).toHaveBeenCalledWith(
      'buyer-1',
      ORDER_ID,
      'Seller could not fulfil',
    );
    const email = mailService.sendMail.mock.calls[0][0];
    expect(email.to).toBe('buyer@example.com');
    expect(email.subject).toContain('cancelled');
    expect(email.text).toContain('Seller could not fulfil');
    expect(otpSmsService.sendTransactional).toHaveBeenCalled();
  });

  it('keeps an admin-typed reason out of the DLT-approved SMS', async () => {
    const { service, otpSmsService } = buildCancel();

    await service.cancelOrder('admin-1', ORDER_ID, 'ADMIN', 'Seller could not fulfil');
    await flush();

    const [, message] = otpSmsService.sendTransactional.mock.calls[0];
    expect(message).not.toContain('Seller could not fulfil');
    expect(message).not.toContain('http');
  });

  it('still cancels when telling the buyer fails', async () => {
    const { service, mailService } = buildCancel();
    mailService.sendMail.mockRejectedValue(new Error('smtp down'));

    await expect(
      service.cancelOrder('admin-1', ORDER_ID, 'ADMIN', 'whatever'),
    ).resolves.toBeDefined();
    await flush();
  });
});
