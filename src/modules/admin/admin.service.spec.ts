import { AdminService } from './admin.service';
import { OrderStatus, PaymentStatus, Role } from '@prisma/client';

// Shared across every AdminService construction below. Returning undefined
// for every key means callers fall through to their hardcoded defaults
// (e.g. TEST_BUYER_PHONES -> '8500237151'), matching the pre-config-change
// behavior unless a specific test overrides `get` for its own key.
const mockConfigService = { get: jest.fn().mockReturnValue(undefined) };

// Marking a settlement paid now emails the seller their commission invoice.
// Fire-and-forget, so every harness just needs something callable.
const payoutEmailStub = { settlementPaid: jest.fn().mockResolvedValue(undefined) };


const baseOrder = {
  id: 'order-1',
  orderStatus: OrderStatus.PAYMENT_RECEIVED,
  paymentStatus: PaymentStatus.SUCCESS,
  shiprocketOrderId: null,
  address: {},
  buyer: { email: 'b@example.com', phone: '9000000000', buyerProfile: null },
  items: [],
};

const build = (pushResult: Record<string, unknown> = {}) => {
  const prisma = {
    order: {
      findUnique: jest.fn().mockResolvedValue(baseOrder),
      update: jest.fn().mockResolvedValue(baseOrder),
    },
    sellerSettlement: { findUnique: jest.fn() },
  };
  const notificationsService = {};
  const ordersService = {
    pushOrderToShiprocketIfNeeded: jest.fn().mockResolvedValue(pushResult),
    notifyBuyerOfStatusChange: jest.fn().mockResolvedValue(undefined),
  };
  const sellersService = {};
  const service = new AdminService(
    prisma as never,
    notificationsService as never,
    ordersService as never,
    sellersService as never,
    {} as never,
    {} as never,
    mockConfigService as never,
    payoutEmailStub as never,
  );
  return { service, prisma, ordersService };
};

describe('AdminService.adminUpdateOrderStatus — Shiprocket wiring', () => {
  it('pushes to Shiprocket when the admin advances an order to READY_TO_SHIP', async () => {
    const { service, ordersService } = build({
      shiprocketOrderId: 'sr-1',
      shipmentId: 'sh-1',
    });
    await service.adminUpdateOrderStatus('order-1', {
      status: OrderStatus.READY_TO_SHIP,
    } as never);
    expect(ordersService.pushOrderToShiprocketIfNeeded).toHaveBeenCalledWith(
      baseOrder,
    );
  });

  it('merges the returned Shiprocket fields into the order update', async () => {
    const { service, prisma } = build({
      shiprocketOrderId: 'sr-1',
      shipmentId: 'sh-1',
      awbCode: 'AWB1',
      courierName: 'Delhivery',
    });
    await service.adminUpdateOrderStatus('order-1', {
      status: OrderStatus.READY_TO_SHIP,
    } as never);
    expect(prisma.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          orderStatus: OrderStatus.READY_TO_SHIP,
          shiprocketOrderId: 'sr-1',
          shipmentId: 'sh-1',
          awbCode: 'AWB1',
          courierName: 'Delhivery',
        }),
      }),
    );
  });

  it('does not touch Shiprocket for any other status transition', async () => {
    const { service, ordersService } = build();
    await service.adminUpdateOrderStatus('order-1', {
      status: OrderStatus.CANCELLED,
    } as never);
    expect(ordersService.pushOrderToShiprocketIfNeeded).not.toHaveBeenCalled();
  });

  it('notifies the buyer on every admin status change, not just READY_TO_SHIP', async () => {
    const { service, ordersService } = build();
    await service.adminUpdateOrderStatus('order-1', {
      status: OrderStatus.SHIPPED,
    } as never);
    expect(ordersService.notifyBuyerOfStatusChange).toHaveBeenCalledWith(
      { id: 'order-1', buyerId: undefined, buyer: baseOrder.buyer },
      OrderStatus.SHIPPED,
    );
  });
});

describe('AdminService.adminUpdateProduct — catalog product resolution', () => {
  const buildForProductUpdate = (offer: Record<string, unknown>) => {
    const prisma = {
      sellerOffer: { findUnique: jest.fn().mockResolvedValue(offer) },
      catalogProduct: { update: jest.fn().mockResolvedValue({ id: 'catalog-1' }) },
    };
    const notificationsService = {};
    const ordersService = {};
    const sellersService = {};
    const service = new AdminService(
      prisma as never,
      notificationsService as never,
      ordersService as never,
      sellersService as never,
      {} as never,
      {} as never,
      mockConfigService as never,
      payoutEmailStub as never,
    );
    return { service, prisma };
  };

  it('resolves a directly-linked catalog product (no variant)', async () => {
    const { service, prisma } = buildForProductUpdate({
      id: 'offer-1',
      catalogProduct: { id: 'catalog-1', slug: 'old-slug' },
      variant: null,
    });
    await service.adminUpdateProduct('offer-1', { name: 'New Name' } as never);
    expect(prisma.catalogProduct.update).toHaveBeenCalledWith({
      where: { id: 'catalog-1' },
      data: { name: 'New Name' },
    });
  });

  it('still resolves a variant-linked catalog product', async () => {
    const { service, prisma } = buildForProductUpdate({
      id: 'offer-2',
      catalogProduct: null,
      variant: { catalogProduct: { id: 'catalog-2', slug: 'old-slug-2' } },
    });
    await service.adminUpdateProduct('offer-2', { name: 'New Name 2' } as never);
    expect(prisma.catalogProduct.update).toHaveBeenCalledWith({
      where: { id: 'catalog-2' },
      data: { name: 'New Name 2' },
    });
  });

  it('throws when the listing has neither a direct nor a variant catalog product', async () => {
    const { service } = buildForProductUpdate({
      id: 'offer-3',
      catalogProduct: null,
      variant: null,
    });
    await expect(
      service.adminUpdateProduct('offer-3', { name: 'New Name 3' } as never),
    ).rejects.toThrow('This listing has no catalog product to edit');
  });
});

describe('AdminService.getSettlementsSummary — totals across all pages', () => {
  const payoutInputItem = {
    id: 'item-1',
    sellerId: 'seller-1',
    createdAt: new Date(),
    sellerOffer: {
      mrp: 100,
      finalShippingPrice: 0,
      shippingCharges: 0,
      catalogProduct: { commissionPercent: 0, commissionGstPercent: 0 },
    },
    quantity: 1,
    totalPrice: 100,
  };

  const buildForSummary = ({
    pendingItems = [],
    settledRecords = [],
  }: {
    pendingItems?: unknown[];
    settledRecords?: { amount: string; payoutStatus: string }[];
  }) => {
    const prisma = {
      orderItem: { findMany: jest.fn().mockResolvedValue(pendingItems) },
      sellerSettlement: { findMany: jest.fn().mockResolvedValue(settledRecords) },
    };
    const service = new AdminService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      mockConfigService as never,
      payoutEmailStub as never,
    );
    return { service, prisma };
  };

  it('sums PROJECTED (not-yet-ledgered) amounts across every matching order item, not one page', async () => {
    const { service } = buildForSummary({
      pendingItems: [payoutInputItem, { ...payoutInputItem, id: 'item-2' }],
    });
    const result = await service.getSettlementsSummary({});
    // 2 items x ₹100 gross, 0% commission/shipping => ₹200 net payout, all still pending
    expect(result.gross).toBeCloseTo(200);
    expect(result.pending).toBeCloseTo(200);
    expect(result.totalSettled).toBe(0);
  });

  it('splits ledgered settlements into pending vs settled by payoutStatus, and keeps gross === pending + settled', async () => {
    const { service } = buildForSummary({
      settledRecords: [
        { amount: '968', payoutStatus: 'PENDING' },
        { amount: '5330', payoutStatus: 'PENDING' },
        { amount: '19', payoutStatus: 'PAID' },
      ],
    });
    const result = await service.getSettlementsSummary({});
    expect(result.totalSettled).toBe(19);
    expect(result.pending).toBe(968 + 5330);
    expect(result.gross).toBe(result.pending + result.totalSettled);
  });

  it('combines projected and ledgered amounts into one true gross total', async () => {
    const { service } = buildForSummary({
      pendingItems: [payoutInputItem],
      settledRecords: [{ amount: '50', payoutStatus: 'PAID' }],
    });
    const result = await service.getSettlementsSummary({});
    expect(result.totalSettled).toBe(50);
    expect(result.pending).toBeCloseTo(100);
    expect(result.gross).toBeCloseTo(150);
  });

  it('skips the projected-item query entirely when filtering to a settled status', async () => {
    const { service, prisma } = buildForSummary({
      settledRecords: [{ amount: '50', payoutStatus: 'PAID' }],
    });
    await service.getSettlementsSummary({ status: 'PAID' });
    expect(prisma.orderItem.findMany).not.toHaveBeenCalled();
  });
});

describe('AdminService.getAllSettlements — pagination priority', () => {
  const buildForList = ({
    pendingCount = 0,
    settledCount = 0,
  }: {
    pendingCount?: number;
    settledCount?: number;
  }) => {
    const prisma = {
      orderItem: {
        count: jest.fn().mockResolvedValue(pendingCount),
        findMany: jest.fn().mockResolvedValue([]),
      },
      sellerSettlement: {
        count: jest.fn().mockResolvedValue(settledCount),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const service = new AdminService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      mockConfigService as never,
      payoutEmailStub as never,
    );
    return { service, prisma };
  };

  it('does not starve real settlement records off page 1 of the default "ALL" view when there are enough PROJECTED items to fill the whole page', async () => {
    // 50 not-yet-delivered order items (PROJECTED) vs only 3 real settlement
    // records. Before the fix, PROJECTED items filled the page first and
    // took up all 20 slots, so sellerSettlement.findMany never ran with a
    // meaningful take on page 1 — the 3 real settlements were unreachable
    // without paging through every PROJECTED entry first.
    const { service, prisma } = buildForList({ pendingCount: 50, settledCount: 3 });

    await service.getAllSettlements({ page: 1, limit: 20 } as never);

    expect(prisma.sellerSettlement.findMany).toHaveBeenCalledTimes(1);
    const call = prisma.sellerSettlement.findMany.mock.calls[0][0];
    expect(call.skip).toBe(0);
    expect(call.take).toBeGreaterThan(0);
  });

  it('fills remaining page space with PROJECTED items once real settlements are exhausted, in the default "ALL" view', async () => {
    const { service, prisma } = buildForList({ pendingCount: 50, settledCount: 3 });

    await service.getAllSettlements({ page: 1, limit: 20 } as never);

    expect(prisma.sellerSettlement.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 0, take: 3 }),
    );
    expect(prisma.orderItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 0, take: 17 }),
    );
  });

  it('orders real settlements before PROJECTED items within a page in the default "ALL" view', async () => {
    const { service, prisma } = buildForList({ pendingCount: 50, settledCount: 3 });
    prisma.orderItem.findMany.mockResolvedValue([
      {
        id: 'item-1',
        sellerId: 'seller-1',
        orderId: 'order-1',
        totalPrice: 100,
        createdAt: new Date(),
        sellerOffer: {
          mrp: 100,
          finalShippingPrice: 0,
          shippingCharges: 0,
          catalogProduct: { commissionPercent: 0, commissionGstPercent: 0 },
        },
        seller: { id: 'seller-1', companyName: 'Seller 1', userId: 'u-1' },
        quantity: 1,
      },
    ]);
    prisma.sellerSettlement.findMany.mockResolvedValue([
      { id: 'settlement-1', payoutStatus: 'PENDING' },
    ]);

    const result = await service.getAllSettlements({ page: 1, limit: 20 } as never);

    expect(result.data[0].id).toBe('settlement-1');
    expect(result.data[1].id).toBe('projected-item-1');
  });

  it('keeps the explicit PROJECTED-filter view unchanged — no real settlements are fetched', async () => {
    const { service, prisma } = buildForList({ pendingCount: 50, settledCount: 3 });

    await service.getAllSettlements({ status: 'PROJECTED', page: 1, limit: 20 } as never);

    expect(prisma.orderItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 0, take: 20 }),
    );
    expect(prisma.sellerSettlement.findMany).not.toHaveBeenCalled();
  });

  it('keeps the explicit settled-status-filter view (the current workaround) unchanged — no PROJECTED items are fetched', async () => {
    const { service, prisma } = buildForList({ pendingCount: 50, settledCount: 3 });

    await service.getAllSettlements({ status: 'PENDING', page: 1, limit: 20 } as never);

    expect(prisma.sellerSettlement.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 0, take: 20 }),
    );
    expect(prisma.orderItem.findMany).not.toHaveBeenCalled();
  });

  it('computes total as pendingCount + settledCount the same way regardless of which branch is taken', async () => {
    const { service: allService } = buildForList({ pendingCount: 50, settledCount: 3 });
    const allResult = await allService.getAllSettlements({ page: 1, limit: 20 } as never);
    expect(allResult.total).toBe(53);

    const { service: projectedService } = buildForList({ pendingCount: 50, settledCount: 3 });
    const projectedResult = await projectedService.getAllSettlements({
      status: 'PROJECTED',
      page: 1,
      limit: 20,
    } as never);
    expect(projectedResult.total).toBe(50);

    const { service: settledService } = buildForList({ pendingCount: 50, settledCount: 3 });
    const settledResult = await settledService.getAllSettlements({
      status: 'PENDING',
      page: 1,
      limit: 20,
    } as never);
    expect(settledResult.total).toBe(3);
  });

  it('does not fall back to PROJECTED items when settledCount exactly fills the page (takeSettled === limit)', async () => {
    // 20 real settlements, page size 20 — settled records alone fill the
    // whole page exactly, so the `takeSettled < limit` pending-fallback
    // must NOT fire even though there's plenty of pending data available.
    const { service, prisma } = buildForList({ pendingCount: 50, settledCount: 20 });

    await service.getAllSettlements({ page: 1, limit: 20 } as never);

    expect(prisma.sellerSettlement.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 0, take: 20 }),
    );
    expect(prisma.orderItem.findMany).not.toHaveBeenCalled();
  });

  it('falls straight through to the pending-only path when settledCount is 0, in the default "ALL" view', async () => {
    const { service, prisma } = buildForList({ pendingCount: 50, settledCount: 0 });

    await service.getAllSettlements({ page: 1, limit: 20 } as never);

    expect(prisma.orderItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 0, take: 20 }),
    );
    expect(prisma.sellerSettlement.findMany).not.toHaveBeenCalled();
  });
});

describe('AdminService.getDashboard — Platform Revenue', () => {
  const buildForDashboard = () => {
    const emptyResult = { _sum: { totalAmount: null }, _count: { id: 0 } };
    const prisma = {
      user: { count: jest.fn().mockResolvedValue(0) },
      order: {
        count: jest.fn().mockResolvedValue(0),
        aggregate: jest.fn().mockResolvedValue(emptyResult),
        findMany: jest.fn().mockResolvedValue([]),
      },
      payment: { count: jest.fn().mockResolvedValue(0) },
      sellerSettlement: { count: jest.fn().mockResolvedValue(0) },
      sellerOffer: { count: jest.fn().mockResolvedValue(0) },
      ticket: { count: jest.fn().mockResolvedValue(0) },
      // Every order figure now goes through the shared not-a-test filter,
      // which reads the per-order overrides. None stored here.
      systemSetting: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new AdminService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      mockConfigService as never,
      payoutEmailStub as never,
    );
    return { service, prisma };
  };

  it('scopes Platform Revenue to paid, non-cancelled/returned orders', async () => {
    const { service, prisma } = buildForDashboard();
    await service.getDashboard({});
    const revenueCall = prisma.order.aggregate.mock.calls[0][0];
    expect(revenueCall.where).toMatchObject({
      paymentStatus: PaymentStatus.SUCCESS,
      orderStatus: { notIn: [OrderStatus.CANCELLED, OrderStatus.RETURNED] },
    });
  });

  it('still counts every order (regardless of payment) toward Total Orders, aside from the known test-buyer exclusion', async () => {
    const { service, prisma } = buildForDashboard();
    await service.getDashboard({});
    const totalOrdersCall = prisma.order.count.mock.calls[0][0];
    expect(totalOrdersCall).toEqual({ where: { AND: [excludedTestBuyers] } });
  });

  it('leaves the DELIVERED-only referral revenue aggregate untouched', async () => {
    const { service, prisma } = buildForDashboard();
    await service.getDashboard({});
    const referralCall = prisma.order.aggregate.mock.calls[1][0];
    expect(referralCall.where).toMatchObject({
      referralCodeId: { not: null },
      orderStatus: OrderStatus.DELIVERED,
    });
    // Only the first aggregate call (Platform Revenue) gets the test-buyer
    // exclusion — the referral aggregate is intentionally untouched.
    expect(referralCall.where.buyer).toBeUndefined();
  });

  it('excludes the known test-buyer account from Total Orders so it agrees with Order Monitoring', async () => {
    const { service, prisma } = buildForDashboard();
    await service.getDashboard({});
    expect(prisma.order.count).toHaveBeenCalledWith({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      where: expect.objectContaining({ AND: [excludedTestBuyers] }),
    });
  });

  it('excludes the known test-buyer account from the Platform Revenue aggregate', async () => {
    const { service, prisma } = buildForDashboard();
    await service.getDashboard({});
    const revenueCall = prisma.order.aggregate.mock.calls[0][0];
    expect(revenueCall.where).toMatchObject({ AND: [excludedTestBuyers] });
  });

  it('excludes the known test-buyer account from Recent Orders', async () => {
    const { service, prisma } = buildForDashboard();
    await service.getDashboard({});
    const recentOrdersCall = prisma.order.findMany.mock.calls[0][0];
    expect(recentOrdersCall.where).toMatchObject({ AND: [excludedTestBuyers] });
  });
});

describe('AdminService.approveUser — seller approval email', () => {
  const buildForApprove = (user: {
    id: string;
    role: string;
    email: string | null;
    status: string;
    sellerProfile: { userId: string; email: string | null; companyName: string } | null;
  }) => {
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue(user),
        update: jest.fn().mockResolvedValue(user),
      },
      sellerProfile: { update: jest.fn().mockResolvedValue({}) },
      buyerProfile: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    const notificationsService = { notifyUserVerified: jest.fn().mockResolvedValue(undefined) };
    const ordersService = {};
    const sellersService = {};
    const mailService = { sendMail: jest.fn().mockResolvedValue({ sent: true, retryable: false }) };
    const service = new AdminService(
      prisma as never,
      notificationsService as never,
      ordersService as never,
      sellersService as never,
      mailService as never,
      {} as never,
      mockConfigService as never,
      payoutEmailStub as never,
    );
    return { service, mailService };
  };

  it('emails the seller profile address when the approved user is a seller', async () => {
    const { service, mailService } = buildForApprove({
      id: 'user-1',
      role: 'SELLER',
      email: 'login@example.com',
      status: 'PENDING',
      sellerProfile: { userId: 'user-1', email: 'company@example.com', companyName: 'Acme' },
    });

    await service.approveUser('user-1');

    expect(mailService.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'company@example.com' }),
    );
  });

  it('falls back to the login email when the seller profile has none', async () => {
    const { service, mailService } = buildForApprove({
      id: 'user-1',
      role: 'SELLER',
      email: 'login@example.com',
      status: 'PENDING',
      sellerProfile: { userId: 'user-1', email: null, companyName: 'Acme' },
    });

    await service.approveUser('user-1');

    expect(mailService.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'login@example.com' }),
    );
  });

  it('does not email, and does not throw, when a buyer is approved', async () => {
    const { service, mailService } = buildForApprove({
      id: 'user-2',
      role: 'BUYER',
      email: 'buyer@example.com',
      status: 'PENDING',
      sellerProfile: null,
    });

    await expect(service.approveUser('user-2')).resolves.toBeDefined();
    expect(mailService.sendMail).not.toHaveBeenCalled();
  });

  it('does not throw when the seller has no email anywhere on file', async () => {
    const { service, mailService } = buildForApprove({
      id: 'user-1',
      role: 'SELLER',
      email: null,
      status: 'PENDING',
      sellerProfile: { userId: 'user-1', email: null, companyName: 'Acme' },
    });

    await expect(service.approveUser('user-1')).resolves.toBeDefined();
    expect(mailService.sendMail).not.toHaveBeenCalled();
  });

  it('approval succeeds even when the mailer reports failure', async () => {
    const { service, mailService } = buildForApprove({
      id: 'user-1',
      role: 'SELLER',
      email: 'login@example.com',
      status: 'PENDING',
      sellerProfile: { userId: 'user-1', email: 'company@example.com', companyName: 'Acme' },
    });
    mailService.sendMail.mockResolvedValue({ sent: false, retryable: true });

    await expect(service.approveUser('user-1')).resolves.toBeDefined();
  });
});

describe('AdminService.adminCreateProductForSeller', () => {
  it('calls ProductsService.create with the selected seller id, the product fields, and the admin id', async () => {
    const productsService = {
      create: jest.fn().mockResolvedValue({ id: 'offer-1' }),
    };
    const service = new AdminService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      productsService as never,
      mockConfigService as never,
      payoutEmailStub as never,
    );

    const dto = {
      sellerId: 'seller-user-1',
      name: 'Test Figurine',
      categoryId: 'cat-1',
      subCategoryId: 'subcat-1',
      manufacturer: 'Test Co',
      mrp: 100,
      gstPercent: 12,
      stock: 10,
      expiryDate: '2099-12-31',
    } as never;

    await service.adminCreateProductForSeller('admin-user-1', dto);

    expect(productsService.create).toHaveBeenCalledWith(
      'seller-user-1',
      expect.objectContaining({ name: 'Test Figurine' }),
      'admin-user-1',
    );
    const passedDto = productsService.create.mock.calls[0][1];
    expect(passedDto.sellerId).toBeUndefined();
  });
});

// The default view hides an order when the phone rule OR an explicit test
// override says test — unless it is explicitly marked real, which beats both.
// With no overrides stored only the phone arm is built.
const excludedTestBuyers = {
  OR: [{ AND: [{ buyer: { phone: { notIn: ['8500237151'] } } }] }],
};

describe('AdminService.getAllOrders — test-order exclusion', () => {
  const buildForOrders = () => {
    const prisma = {
      order: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      systemSetting: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new AdminService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      mockConfigService as never,
      payoutEmailStub as never,
    );
    return { service, prisma };
  };

  it('excludes known test-buyer orders by default (no includeTestOrders param)', async () => {
    const { service, prisma } = buildForOrders();
    await service.getAllOrders({ page: 1, limit: 20 } as never);

    const where = prisma.order.findMany.mock.calls[0][0].where;
    expect(where.AND).toEqual([excludedTestBuyers]);
    expect(prisma.order.count).toHaveBeenCalledWith({ where });
  });

  it('excludes known test-buyer orders when includeTestOrders is anything other than "true"', async () => {
    const { service, prisma } = buildForOrders();
    await service.getAllOrders({ page: 1, limit: 20, includeTestOrders: 'false' } as never);

    const where = prisma.order.findMany.mock.calls[0][0].where;
    expect(where.AND).toEqual([excludedTestBuyers]);
  });

  it('does not apply the exclusion when includeTestOrders is "true"', async () => {
    const { service, prisma } = buildForOrders();
    await service.getAllOrders({ page: 1, limit: 20, includeTestOrders: 'true' } as never);

    const where = prisma.order.findMany.mock.calls[0][0].where;
    expect(where.AND).toBeUndefined();
  });

  it('combines the test-order exclusion with other filters (status) in the same where object', async () => {
    const { service, prisma } = buildForOrders();
    await service.getAllOrders({
      page: 1,
      limit: 20,
      status: OrderStatus.PLACED,
    } as never);

    const where = prisma.order.findMany.mock.calls[0][0].where;
    expect(where.orderStatus).toBe(OrderStatus.PLACED);
    expect(where.AND).toEqual([excludedTestBuyers]);
  });
});

const cancellableTestOrdersWhere = {
  // The phone rule is one arm of an OR now: an explicit per-order test
  // override is the other. With no overrides stored, only this arm is built.
  OR: [{ buyer: { phone: { in: ['8500237151'] } } }],
  orderStatus: {
    notIn: [
      OrderStatus.SHIPPED,
      OrderStatus.DELIVERED,
      OrderStatus.RETURNED,
      OrderStatus.CANCELLED,
    ],
  },
  paymentStatus: { notIn: [PaymentStatus.SUCCESS, PaymentStatus.PARTIAL] },
};

describe('AdminService.countCancellableTestOrders', () => {
  it('counts with the same filter cancelAllTestOrders uses to select orders', async () => {
    const prisma = {
      order: { count: jest.fn().mockResolvedValue(7) },
      systemSetting: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new AdminService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      mockConfigService as never,
      payoutEmailStub as never,
    );

    const result = await service.countCancellableTestOrders();

    expect(prisma.order.count).toHaveBeenCalledWith({ where: cancellableTestOrdersWhere });
    expect(result).toBe(7);
  });
});

describe('AdminService.cancelAllTestOrders', () => {
  const buildForCancel = (testOrders: { id: string; buyerId: string }[] = []) => {
    const prisma = {
      order: {
        findMany: jest.fn().mockResolvedValue(testOrders),
      },
      systemSetting: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const ordersService = {
      cancelOrder: jest.fn().mockResolvedValue(undefined),
    };
    const service = new AdminService(
      prisma as never,
      {} as never,
      ordersService as never,
      {} as never,
      {} as never,
      {} as never,
      mockConfigService as never,
      payoutEmailStub as never,
    );
    return { service, prisma, ordersService };
  };

  it('queries only test-buyer orders that are not terminal and not already paid for', async () => {
    const { service, prisma } = buildForCancel();

    await service.cancelAllTestOrders();

    expect(prisma.order.findMany).toHaveBeenCalledWith({
      where: cancellableTestOrdersWhere,
      select: { id: true, buyerId: true },
    });
  });

  it('cancels each matching order as ADMIN and reports the summary', async () => {
    const { service, ordersService } = buildForCancel([
      { id: 'order-1', buyerId: 'buyer-1' },
      { id: 'order-2', buyerId: 'buyer-2' },
    ]);

    const result = await service.cancelAllTestOrders();

    expect(ordersService.cancelOrder).toHaveBeenCalledWith('buyer-1', 'order-1', Role.ADMIN);
    expect(ordersService.cancelOrder).toHaveBeenCalledWith('buyer-2', 'order-2', Role.ADMIN);
    expect(result).toEqual({ cancelled: 2, failed: 0, total: 2 });
  });

  it('continues past a per-order failure and reports it in the summary', async () => {
    const { service, ordersService } = buildForCancel([
      { id: 'order-1', buyerId: 'buyer-1' },
      { id: 'order-2', buyerId: 'buyer-2' },
    ]);
    ordersService.cancelOrder
      .mockRejectedValueOnce(new Error('already paid'))
      .mockResolvedValueOnce(undefined);

    const result = await service.cancelAllTestOrders();

    expect(ordersService.cancelOrder).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ cancelled: 1, failed: 1, total: 2 });
  });

  it('does nothing and reports zeroes when there are no test orders to cancel', async () => {
    const { service, ordersService } = buildForCancel([]);

    const result = await service.cancelAllTestOrders();

    expect(ordersService.cancelOrder).not.toHaveBeenCalled();
    expect(result).toEqual({ cancelled: 0, failed: 0, total: 0 });
  });
});

describe('AdminService.getAllProducts — other-sellers aggregation', () => {
  const buildForProducts = () => {
    const prisma = {
      sellerOffer: {
        findMany: jest.fn(),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    const service = new AdminService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      mockConfigService as never,
      payoutEmailStub as never,
    );
    return { service, prisma };
  };

  it('reports sellerCount 1 and no sellers list for an offer with no catalog product link', async () => {
    const { service, prisma } = buildForProducts();
    prisma.sellerOffer.findMany.mockResolvedValueOnce([
      { id: 'offer-1', catalogProductId: null, variant: null },
    ]);

    const result = await service.getAllProducts({ page: 1, limit: 20 } as never);

    expect(result.data).toEqual([
      { id: 'offer-1', catalogProductId: null, variant: null, sellerCount: 1, sellers: [] },
    ]);
    expect(prisma.sellerOffer.findMany).toHaveBeenCalledTimes(1);
  });

  it('resolves siblings through the direct catalogProductId path and lists every carrying seller once each', async () => {
    const { service, prisma } = buildForProducts();
    prisma.sellerOffer.findMany
      .mockResolvedValueOnce([
        { id: 'offer-1', catalogProductId: 'cp-1', variant: null },
      ])
      .mockResolvedValueOnce([
        { catalogProductId: 'cp-1', variant: null, seller: { id: 'seller-1', companyName: 'Acme' } },
        { catalogProductId: 'cp-1', variant: null, seller: { id: 'seller-2', companyName: 'Beta' } },
      ]);

    const result = await service.getAllProducts({ page: 1, limit: 20 } as never);

    expect(result.data[0].sellerCount).toBe(2);
    expect(result.data[0].sellers).toEqual([
      { id: 'seller-1', companyName: 'Acme' },
      { id: 'seller-2', companyName: 'Beta' },
    ]);
    expect(prisma.sellerOffer.findMany).toHaveBeenNthCalledWith(2, {
      where: {
        deletedAt: null,
        OR: [
          { catalogProductId: { in: ['cp-1'] } },
          { variant: { catalogProductId: { in: ['cp-1'] } } },
        ],
      },
      select: {
        catalogProductId: true,
        variant: { select: { catalogProductId: true } },
        seller: { select: { id: true, companyName: true } },
      },
    });
  });

  it('resolves siblings through the variant path when catalogProductId is null on the row itself', async () => {
    const { service, prisma } = buildForProducts();
    prisma.sellerOffer.findMany
      .mockResolvedValueOnce([
        { id: 'offer-1', catalogProductId: null, variant: { catalogProduct: { id: 'cp-1' } } },
      ])
      .mockResolvedValueOnce([
        { catalogProductId: null, variant: { catalogProductId: 'cp-1' }, seller: { id: 'seller-1', companyName: 'Acme' } },
        { catalogProductId: 'cp-1', variant: null, seller: { id: 'seller-2', companyName: 'Beta' } },
      ]);

    const result = await service.getAllProducts({ page: 1, limit: 20 } as never);

    expect(result.data[0].sellerCount).toBe(2);
    expect(result.data[0].sellers.map((s: { companyName: string }) => s.companyName)).toEqual(['Acme', 'Beta']);
  });

  it('dedupes a seller who appears twice among siblings (e.g. both a direct and a variant offer for the same catalog product)', async () => {
    const { service, prisma } = buildForProducts();
    prisma.sellerOffer.findMany
      .mockResolvedValueOnce([
        { id: 'offer-1', catalogProductId: 'cp-1', variant: null },
      ])
      .mockResolvedValueOnce([
        { catalogProductId: 'cp-1', variant: null, seller: { id: 'seller-1', companyName: 'Acme' } },
        { catalogProductId: null, variant: { catalogProductId: 'cp-1' }, seller: { id: 'seller-1', companyName: 'Acme' } },
      ]);

    const result = await service.getAllProducts({ page: 1, limit: 20 } as never);

    expect(result.data[0].sellerCount).toBe(1);
    expect(result.data[0].sellers).toEqual([{ id: 'seller-1', companyName: 'Acme' }]);
  });
});


describe('AdminService.updateSellerSelfShip', () => {
  const build = (seller: object | null) => {
    const prisma = {
      sellerProfile: {
        findUnique: jest.fn().mockResolvedValue(seller),
        update: jest.fn().mockResolvedValue({
          id: 'seller-1',
          companyName: 'Acme',
          selfShipEnabled: true,
        }),
      },
    };
    const service = new AdminService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      payoutEmailStub as never,
    );
    return { service, prisma };
  };

  it('updates ONLY the selfShipEnabled flag', async () => {
    const { service, prisma } = build({ id: 'seller-1' });

    await service.updateSellerSelfShip('seller-1', { selfShipEnabled: true });

    expect(prisma.sellerProfile.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'seller-1' },
        data: { selfShipEnabled: true },
      }),
    );
  });

  it('404s for an unknown seller profile', async () => {
    const { service, prisma } = build(null);

    await expect(
      service.updateSellerSelfShip('nope', { selfShipEnabled: true }),
    ).rejects.toThrow('Seller profile not found');
    expect(prisma.sellerProfile.update).not.toHaveBeenCalled();
  });
});

describe('AdminService.getPublicSettings — SEO verification tokens', () => {
  const buildForSettings = (rows: { key: string; value: string }[]) => {
    const prisma = {
      systemSetting: { findMany: jest.fn().mockResolvedValue(rows) },
    };
    const service = new AdminService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      mockConfigService as never,
      payoutEmailStub as never,
    );
    return { service };
  };

  it('exposes stored Google/Bing verification tokens publicly', async () => {
    const { service } = buildForSettings([
      { key: 'googleSiteVerification', value: 'gsc-token-123' },
      { key: 'bingSiteVerification', value: 'bing-token-456' },
    ]);

    const settings = await service.getPublicSettings();

    expect(settings.googleSiteVerification).toBe('gsc-token-123');
    expect(settings.bingSiteVerification).toBe('bing-token-456');
  });

  it('defaults both tokens to empty strings when never configured', async () => {
    const { service } = buildForSettings([]);

    const settings = await service.getPublicSettings();

    expect(settings.googleSiteVerification).toBe('');
    expect(settings.bingSiteVerification).toBe('');
  });
});

describe('AdminService.getPublicSettings — storefront SEO defaults', () => {
  const build = (rows: { key: string; value: string }[]) => {
    const prisma = { systemSetting: { findMany: jest.fn().mockResolvedValue(rows) } };
    return new AdminService(
      prisma as never, {} as never, {} as never, {} as never,
      {} as never, {} as never, mockConfigService as never, payoutEmailStub as never,
    );
  };

  it('exposes admin-set SEO defaults to the storefront', async () => {
    const service = build([
      { key: 'seoTitleTemplate', value: '%s | Yukizi India' },
      { key: 'seoTwitterHandle', value: '@yukizi' },
      { key: 'seoProductTitleSuffix', value: ' — Buy Online in India' },
    ]);

    const s = await service.getPublicSettings();

    expect(s.seoTitleTemplate).toBe('%s | Yukizi India');
    expect(s.seoTwitterHandle).toBe('@yukizi');
    expect(s.seoProductTitleSuffix).toBe(' — Buy Online in India');
  });

  it('defaults every SEO field to blank when unset', async () => {
    const s = await build([]).getPublicSettings();

    expect(s.seoTitleTemplate).toBe('');
    expect(s.seoDefaultOgImage).toBe('');
    expect(s.seoProductTitleSuffix).toBe('');
  });

  // The out-of-stock noindex setting was removed: the storefront never read it,
  // and noindexing a product that is only temporarily between sellers would
  // discard the ranking the permanent product URL exists to protect.
  it('no longer exposes the out-of-stock noindex setting', async () => {
    const s = await build([
      { key: 'seoNoindexOutOfStock', value: 'true' },
    ]).getPublicSettings();

    expect(s).not.toHaveProperty('seoNoindexOutOfStock');
  });
});

describe('AdminService.getPublicSettings — social profiles', () => {
  const build = (rows: { key: string; value: string }[]) => {
    const prisma = { systemSetting: { findMany: jest.fn().mockResolvedValue(rows) } };
    return new AdminService(
      prisma as never, {} as never, {} as never, {} as never,
      {} as never, {} as never, mockConfigService as never, payoutEmailStub as never,
    );
  };

  it('exposes configured social URLs to the storefront', async () => {
    const s = await build([
      { key: 'socialInstagram', value: 'https://instagram.com/yukizi' },
      { key: 'socialDiscord', value: 'https://discord.gg/yukizi' },
    ]).getPublicSettings();

    expect(s.socialInstagram).toBe('https://instagram.com/yukizi');
    expect(s.socialDiscord).toBe('https://discord.gg/yukizi');
    expect(s.socialFacebook).toBe('');
  });
});

describe('AdminService.getPublicSettings — support contact', () => {
  const build = (rows: { key: string; value: string }[]) => {
    const mockPrisma = {
      systemSetting: { findMany: jest.fn().mockResolvedValue(rows) },
    };
    const mockConfigService = { get: jest.fn() };
    return new AdminService(
      mockPrisma as never, {} as never, {} as never, {} as never,
      {} as never, {} as never, mockConfigService as never, payoutEmailStub as never,
    );
  };

  it('exposes admin-set support contact details to the storefront', async () => {
    const s = await build([
      { key: 'supportEmail', value: 'help@yukizi.com' },
      { key: 'supportPhone', value: '+91 90000 00000' },
    ]).getPublicSettings();

    expect(s.supportEmail).toBe('help@yukizi.com');
    expect(s.supportPhone).toBe('+91 90000 00000');
  });

  // Blank must mean "use the storefront's own constants". The old defaults
  // were placeholders (support@yukizi.in, +91 1800-XXX-XXXX) that would have
  // been published as real contact details the moment anything read them.
  it('defaults both to blank so the storefront falls back to its own details', async () => {
    const s = await build([]).getPublicSettings();

    expect(s.supportEmail).toBe('');
    expect(s.supportPhone).toBe('');
  });
});

/**
 * TEST_BUYER_PHONES classifies by WHO placed an order, which cannot express
 * "these two are real, everything else from that number was me testing".
 * These cover the per-order overrides that sit on top of it — and, most
 * importantly, that an order marked REAL can never be swept up by the bulk
 * test-order cancel, which would be unrecoverable.
 */
describe('AdminService — per-order test/real overrides', () => {
  const TEST_PHONE = '8500237151';
  const REAL_ID = '15d8cb94-1111-2222-3333-444444444444';
  const TEST_ID = '2abdcd93-5555-6666-7777-888888888888';

  const buildForOverrides = (
    settings: { realOrderIds?: string; testOrderIds?: string } = {},
  ) => {
    const prisma = {
      order: {
        findUnique: jest.fn().mockResolvedValue({ id: REAL_ID }),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      systemSetting: {
        findMany: jest.fn().mockResolvedValue(
          Object.entries(settings).map(([key, value]) => ({ key, value })),
        ),
        upsert: jest.fn().mockImplementation((args: unknown) => args),
      },
      $transaction: jest.fn().mockResolvedValue([]),
    };
    const service = new AdminService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      mockConfigService as never,
      payoutEmailStub as never,
    );
    return { service, prisma };
  };

  const classifyOf = (service: AdminService) =>
    (
      service as unknown as {
        classify(
          o: { id: string; buyer?: { phone?: string | null } | null },
          phones: string[],
          ov: { real: string[]; test: string[] },
        ): { isTest: boolean; classification: string };
      }
    ).classify.bind(service);

  it('marks an order real even though the test phone placed it', () => {
    const { service } = buildForOverrides();
    const result = classifyOf(service)(
      { id: REAL_ID, buyer: { phone: TEST_PHONE } },
      [TEST_PHONE],
      { real: [REAL_ID], test: [] },
    );
    expect(result).toEqual({ isTest: false, classification: 'real' });
  });

  it('marks an order test even though an ordinary customer placed it', () => {
    const { service } = buildForOverrides();
    const result = classifyOf(service)(
      { id: TEST_ID, buyer: { phone: '9967254696' } },
      [TEST_PHONE],
      { real: [], test: [TEST_ID] },
    );
    expect(result).toEqual({ isTest: true, classification: 'test' });
  });

  it('falls back to the phone rule when there is no override', () => {
    const { service } = buildForOverrides();
    const classify = classifyOf(service);
    expect(classify({ id: 'x', buyer: { phone: TEST_PHONE } }, [TEST_PHONE], { real: [], test: [] }))
      .toEqual({ isTest: true, classification: 'auto' });
    expect(classify({ id: 'y', buyer: { phone: '9967254696' } }, [TEST_PHONE], { real: [], test: [] }))
      .toEqual({ isTest: false, classification: 'auto' });
  });

  it('never lets the bulk test cancel touch an order marked real', async () => {
    const { service, prisma } = buildForOverrides({ realOrderIds: REAL_ID });

    await service.countCancellableTestOrders();

    const where = prisma.order.count.mock.calls[0][0].where as {
      id?: { notIn?: string[] };
    };
    expect(where.id?.notIn).toContain(REAL_ID);
  });

  it('sweeps an order marked test even though its buyer is not a test phone', async () => {
    const { service, prisma } = buildForOverrides({ testOrderIds: TEST_ID });

    await service.countCancellableTestOrders();

    const where = prisma.order.count.mock.calls[0][0].where as {
      OR?: Array<Record<string, unknown>>;
    };
    expect(JSON.stringify(where.OR)).toContain(TEST_ID);
  });

  it('moves an id between the lists rather than leaving it in both', async () => {
    const { service, prisma } = buildForOverrides({ testOrderIds: REAL_ID });

    await service.setOrderClassification(REAL_ID, 'real');

    const written = prisma.systemSetting.upsert.mock.calls.map(
      (c: Array<{ where: { key: string }; create: { value: string } }>) => c[0],
    );
    const real = written.find((w) => w.where.key === 'realOrderIds');
    const test = written.find((w) => w.where.key === 'testOrderIds');
    expect(real?.create.value).toBe(REAL_ID);
    expect(test?.create.value).toBe('');
  });

  it("'auto' drops the order from both lists", async () => {
    const { service, prisma } = buildForOverrides({ realOrderIds: REAL_ID });

    await service.setOrderClassification(REAL_ID, 'auto');

    const written = prisma.systemSetting.upsert.mock.calls.map(
      (c: Array<{ where: { key: string }; create: { value: string } }>) => c[0],
    );
    expect(written.find((w) => w.where.key === 'realOrderIds')?.create.value).toBe('');
    expect(written.find((w) => w.where.key === 'testOrderIds')?.create.value).toBe('');
  });

  it('falls back to the phone rule alone when the settings table cannot be read', async () => {
    const { service, prisma } = buildForOverrides();
    prisma.systemSetting.findMany.mockRejectedValue(new Error('db down'));

    await expect(service.countCancellableTestOrders()).resolves.toBe(0);
  });
});

/**
 * The dashboard used to write the phone rule out at each call site, so
 * marking an order real brought it into the orders list while Total Orders
 * and Platform Revenue carried on ignoring it — two screens, two answers,
 * same order. Every order figure now goes through one shared filter.
 */
describe('AdminService.getDashboard — honours per-order overrides', () => {
  const REAL_ID = '15d8cb94-1111-2222-3333-444444444444';

  const buildForDashboardOverrides = () => {
    const prisma = {
      user: { count: jest.fn().mockResolvedValue(0) },
      order: {
        count: jest.fn().mockResolvedValue(0),
        aggregate: jest.fn().mockResolvedValue({ _sum: { totalAmount: null }, _count: { id: 0 } }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      payment: { count: jest.fn().mockResolvedValue(0) },
      sellerSettlement: { count: jest.fn().mockResolvedValue(0) },
      sellerOffer: { count: jest.fn().mockResolvedValue(0) },
      ticket: { count: jest.fn().mockResolvedValue(0) },
      systemSetting: {
        findMany: jest.fn().mockResolvedValue([{ key: 'realOrderIds', value: REAL_ID }]),
      },
    };
    const service = new AdminService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      mockConfigService as never,
    );
    return { service, prisma };
  };

  it('counts an order marked real toward Total Orders, whoever placed it', async () => {
    const { service, prisma } = buildForDashboardOverrides();
    await service.getDashboard({});
    expect(JSON.stringify(prisma.order.count.mock.calls[0][0])).toContain(REAL_ID);
  });

  it('counts an order marked real toward Platform Revenue', async () => {
    const { service, prisma } = buildForDashboardOverrides();
    await service.getDashboard({});
    expect(JSON.stringify(prisma.order.aggregate.mock.calls[0][0].where)).toContain(REAL_ID);
  });

  it('shows an order marked real in Recent Platform Orders', async () => {
    const { service, prisma } = buildForDashboardOverrides();
    await service.getDashboard({});
    expect(JSON.stringify(prisma.order.findMany.mock.calls[0][0].where)).toContain(REAL_ID);
  });

  it('asks for the overrides once, not once per figure', async () => {
    const { service, prisma } = buildForDashboardOverrides();
    await service.getDashboard({});
    expect(prisma.systemSetting.findMany).toHaveBeenCalledTimes(1);
  });
});
