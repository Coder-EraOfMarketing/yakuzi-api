import { ProductsService } from './products.service';
import type { CreateProductDto } from './dto/create-product.dto';

const dto = (): CreateProductDto =>
  ({
    name: 'Test Figurine',
    categoryId: 'cat-1',
    subCategoryId: 'subcat-1',
    manufacturer: 'Test Co',
    mrp: 100,
    gstPercent: 12,
    stock: 10,
    expiryDate: '2099-12-31',
  }) as CreateProductDto;

const build = () => {
  const offer = {
    id: 'offer-1',
    mrp: 100,
    gstPercent: 12,
    finalShippingPrice: null,
    shippingCharges: 0,
    discountType: null,
    discountMeta: null,
    isTaxIncluded: false,
  };
  const prisma = {
    sellerProfile: {
      findUnique: jest.fn().mockResolvedValue({ id: 'seller-profile-1' }),
    },
    category: {
      findUnique: jest.fn().mockResolvedValue({ id: 'cat-1', name: 'Figurines' }),
    },
    subCategory: {
      findUnique: jest.fn().mockResolvedValue({ id: 'subcat-1', name: 'Funko Pop' }),
    },
    sellerOffer: {
      findUnique: jest.fn().mockResolvedValue(offer),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue(offer),
      update: jest.fn().mockResolvedValue(offer),
    },
    catalogProduct: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
    },
    productBatch: {
      findFirst: jest.fn().mockResolvedValue({ stock: 10, expiryDate: '2099-12-31' }),
    },
  };
  const inventoryService = {
    createDefaultBatch: jest.fn().mockResolvedValue(undefined),
    updateDefaultBatch: jest.fn().mockResolvedValue(undefined),
  };
  const service = new ProductsService(
    prisma as never,
    inventoryService as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, prisma, inventoryService };
};

describe('ProductsService.create — createdByAdminId', () => {
  it('stores createdByAdmin (relation-connect) on the new SellerOffer when provided', async () => {
    const { service, prisma } = build();

    await service.create('seller-user-1', dto(), 'admin-user-1');

    const data = prisma.sellerOffer.create.mock.calls[0][0].data;
    expect(data.createdByAdmin).toEqual({ connect: { id: 'admin-user-1' } });
  });

  it('leaves createdByAdmin unset when the seller creates their own listing (no third argument)', async () => {
    const { service, prisma } = build();

    await service.create('seller-user-1', dto());

    const data = prisma.sellerOffer.create.mock.calls[0][0].data;
    expect(data.createdByAdmin).toBeUndefined();
  });

  it('resolves the seller from the given userId, not any ambient identity', async () => {
    const { service, prisma } = build();

    await service.create('seller-user-1', dto(), 'admin-user-1');

    expect(prisma.sellerProfile.findUnique).toHaveBeenCalledWith({
      where: { userId: 'seller-user-1' },
    });
  });
});

describe('ProductsService — createdByAdminId is never exposed on read', () => {
  it('flattenProduct strips createdByAdminId from the response shape', () => {
    const service = new ProductsService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const raw = {
      id: 'offer-1',
      name: 'Test',
      createdByAdminId: 'admin-user-1',
      batches: [],
      images: [],
      category: { name: 'Figurines' },
      subCategory: { name: 'Funko Pop' },
    };
    const flattened = (service as unknown as {
      flattenProduct(p: Record<string, any>): Record<string, any>;
    }).flattenProduct(raw);
    expect(flattened).not.toHaveProperty('createdByAdminId');
    expect(flattened).not.toHaveProperty('createdByAdmin');
  });
});

describe('ProductsService.validateIds', () => {
  const buildForValidateIds = (offers: any[]) => {
    const prisma = {
      sellerOffer: { findMany: jest.fn().mockResolvedValue(offers) },
    };
    const service = new ProductsService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { service, prisma };
  };

  it('returns price/mrp/stock for a live, in-stock offer', async () => {
    const { service } = buildForValidateIds([
      {
        id: 'offer-1',
        mrp: 100,
        finalCustomerPayable: 90,
        batches: [{ stock: 3 }, { stock: 2 }],
      },
    ]);

    const result = await service.validateIds(['offer-1']);

    expect(result).toEqual([{ id: 'offer-1', price: 90, mrp: 100, stock: 5 }]);
  });

  it('falls back to mrp when finalCustomerPayable is null', async () => {
    const { service } = buildForValidateIds([
      { id: 'offer-1', mrp: 100, finalCustomerPayable: null, batches: [{ stock: 1 }] },
    ]);

    const result = await service.validateIds(['offer-1']);

    expect(result[0].price).toBe(100);
  });

  it('excludes an offer with zero total stock', async () => {
    const { service } = buildForValidateIds([
      { id: 'offer-1', mrp: 100, finalCustomerPayable: 90, batches: [] },
    ]);

    const result = await service.validateIds(['offer-1']);

    expect(result).toEqual([]);
  });

  it('queries only isActive, non-deleted offers among the given ids', async () => {
    const { service, prisma } = buildForValidateIds([]);

    await service.validateIds(['offer-1', 'offer-2']);

    const { where } = prisma.sellerOffer.findMany.mock.calls[0][0];
    expect(where).toMatchObject({
      id: { in: ['offer-1', 'offer-2'] },
      isActive: true,
      deletedAt: null,
    });
  });

  it('also excludes a live offer whose product has gone back to Draft', async () => {
    // "Draft" used to mean hidden from browse only. This query is what the
    // storefront re-checks saved and cart ids against, so without the master's
    // state a Draft product stayed purchasable through every by-id route.
    const { service, prisma } = buildForValidateIds([]);

    await service.validateIds(['offer-1']);

    const { where } = prisma.sellerOffer.findMany.mock.calls[0][0];
    // Both links an offer can take to its product are covered.
    expect(where.NOT.OR).toEqual([
      { catalogProduct: { OR: [{ isActive: false }, { deletedAt: { not: null } }] } },
      {
        variant: {
          catalogProduct: { OR: [{ isActive: false }, { deletedAt: { not: null } }] },
        },
      },
    ]);
  });

  it('returns an empty array for an empty id list without querying', async () => {
    const { service, prisma } = buildForValidateIds([]);

    const result = await service.validateIds([]);

    expect(result).toEqual([]);
    expect(prisma.sellerOffer.findMany).not.toHaveBeenCalled();
  });
});

describe('ProductsService.addToWaitlist', () => {
  const buildForWaitlist = (userEmail: string | null) => {
    const prisma = {
      catalogProduct: {
        findUnique: jest.fn().mockResolvedValue({ id: 'product-1' }),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({ email: userEmail }),
        update: jest.fn().mockResolvedValue({}),
      },
      productWaitlist: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'waitlist-1' }),
      },
    };
    const service = new ProductsService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { service, prisma };
  };

  it('claims the submitted email onto an account that has none', async () => {
    const { service, prisma } = buildForWaitlist(null);

    await service.addToWaitlist('user-1', 'product-1', 'buyer@example.com');

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { email: 'buyer@example.com' },
    });
  });

  it('ignores the submitted email when the account already has one', async () => {
    const { service, prisma } = buildForWaitlist('existing@example.com');

    await service.addToWaitlist('user-1', 'product-1', 'new@example.com');

    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('throws a friendly conflict when the email is already used by another account', async () => {
    const { Prisma } = require('@prisma/client');
    const { service, prisma } = buildForWaitlist(null);
    prisma.user.update.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );

    await expect(
      service.addToWaitlist('user-1', 'product-1', 'taken@example.com'),
    ).rejects.toThrow('This email is already used by another account.');
  });

  it('requires an email when the account has none and none was submitted', async () => {
    const { service } = buildForWaitlist(null);

    await expect(
      service.addToWaitlist('user-1', 'product-1'),
    ).rejects.toThrow(
      'An email address is required so we can notify you when this item is back in stock.',
    );
  });

  it('does not require an email when the account already has one', async () => {
    const { service, prisma } = buildForWaitlist('existing@example.com');

    await expect(
      service.addToWaitlist('user-1', 'product-1'),
    ).resolves.toEqual({ id: 'waitlist-1' });
    expect(prisma.productWaitlist.create).toHaveBeenCalled();
  });
});

describe('ProductsService.notifyWaitlistedUsers', () => {
  const buildForNotify = (
    entries: { userId: string; email: string | null }[],
  ) => {
    const prisma = {
      productWaitlist: {
        findMany: jest.fn().mockResolvedValue(
          entries.map((e, i) => ({
            id: `waitlist-${i}`,
            userId: e.userId,
            catalogProductId: 'product-1',
            catalogProduct: { name: 'Figurine', slug: 'figurine' },
            user: { email: e.email },
          })),
        ),
        updateMany: jest.fn().mockResolvedValue({ count: entries.length }),
      },
      notification: {
        createMany: jest.fn().mockResolvedValue({ count: entries.length }),
      },
    };
    const mailService = {
      sendMail: jest.fn().mockResolvedValue({ sent: true, retryable: false }),
    };
    const service = new ProductsService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      mailService as never,
    );
    return { service, prisma, mailService };
  };

  it('emails every waitlisted user who has an email on file', async () => {
    const { service, mailService } = buildForNotify([
      { userId: 'user-1', email: 'a@example.com' },
      { userId: 'user-2', email: 'b@example.com' },
    ]);

    await service.notifyWaitlistedUsers('product-1');

    expect(mailService.sendMail).toHaveBeenCalledTimes(2);
    expect(mailService.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'a@example.com', subject: expect.stringContaining('back in stock') }),
    );
  });

  it('skips the email but still creates the in-app notification for a user with no email on file', async () => {
    const { service, prisma, mailService } = buildForNotify([
      { userId: 'user-1', email: null },
    ]);

    await service.notifyWaitlistedUsers('product-1');

    expect(mailService.sendMail).not.toHaveBeenCalled();
    expect(prisma.notification.createMany).toHaveBeenCalledWith({
      data: [
        {
          userId: 'user-1',
          message: expect.stringContaining('back in stock'),
        },
      ],
    });
  });

  it('still marks the batch notified even when a mail send fails', async () => {
    const { service, prisma, mailService } = buildForNotify([
      { userId: 'user-1', email: 'a@example.com' },
    ]);
    mailService.sendMail.mockResolvedValue({ sent: false, retryable: true });

    await expect(service.notifyWaitlistedUsers('product-1')).resolves.toBeUndefined();

    expect(prisma.productWaitlist.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['waitlist-0'] } },
      data: { isNotified: true },
    });
  });

  it('does nothing for an empty waitlist', async () => {
    const { service, prisma, mailService } = buildForNotify([]);

    await service.notifyWaitlistedUsers('product-1');

    expect(mailService.sendMail).not.toHaveBeenCalled();
    expect(prisma.notification.createMany).not.toHaveBeenCalled();
    expect(prisma.productWaitlist.updateMany).not.toHaveBeenCalled();
  });
});

describe('ProductsService.findOne — reviewSummary on the detail payload', () => {
  const master = {
    id: 'master-1',
    name: 'Test Figurine',
    slug: 'test-figurine',
    mrp: 100,
    images: [],
    category: { name: 'Figurines' },
    subCategory: null,
    sellerOffers: [],
    productVariants: [],
    options: [],
  };

  const buildForFindOne = (reviewAggregate: {
    _avg: { rating: number | null };
    _count: number;
  }) => {
    const prisma = {
      sellerOffer: { findFirst: jest.fn().mockResolvedValue(null) },
      catalogProduct: { findFirst: jest.fn().mockResolvedValue(master) },
      review: { aggregate: jest.fn().mockResolvedValue(reviewAggregate) },
    };
    const analyticsService = { recordView: jest.fn() };
    const service = new ProductsService(
      prisma as never,
      {} as never,
      {} as never,
      analyticsService as never,
      {} as never,
    );
    return { service, prisma };
  };

  it('includes average and count when the product has reviews', async () => {
    const { service, prisma } = buildForFindOne({ _avg: { rating: 4.3333333 }, _count: 6 });

    const result = (await service.findOne('test-figurine')) as {
      reviewSummary: { average: number; count: number } | null;
    };

    expect(prisma.review.aggregate).toHaveBeenCalledWith({
      where: { catalogProductId: 'master-1' },
      _avg: { rating: true },
      _count: true,
    });
    expect(result.reviewSummary).toEqual({ average: 4.3, count: 6 });
  });

  it('returns reviewSummary: null when the product has no reviews', async () => {
    const { service } = buildForFindOne({ _avg: { rating: null }, _count: 0 });

    const result = (await service.findOne('test-figurine')) as {
      reviewSummary: { average: number; count: number } | null;
    };

    expect(result.reviewSummary).toBeNull();
  });
});
