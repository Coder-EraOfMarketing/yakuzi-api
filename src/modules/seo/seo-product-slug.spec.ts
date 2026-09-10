import { ConflictException, NotFoundException } from '@nestjs/common';
import { SeoService } from './seo.service';

const build = () => {
  const prisma: any = {
    catalogProduct: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    seoRedirect: {
      deleteMany: jest.fn(),
      updateMany: jest.fn(),
      upsert: jest.fn(),
    },
    $transaction: jest.fn((fn: any) => fn(prisma)),
  };
  const service = new SeoService(prisma, { seoMetaChanged: jest.fn() } as never);
  return { service, prisma };
};

describe('SeoService product slug', () => {
  it('getProductSlug throws 404 for an unknown product', async () => {
    const { service, prisma } = build();
    prisma.catalogProduct.findUnique.mockResolvedValue(null);

    await expect(service.getProductSlug('missing')).rejects.toThrow(NotFoundException);
  });

  it('updateProductSlug throws 404 for an unknown product', async () => {
    const { service, prisma } = build();
    prisma.catalogProduct.findUnique.mockResolvedValue(null);

    await expect(service.updateProductSlug('missing', 'testing')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('updateProductSlug normalizes, writes the slug, and 301s the old URL', async () => {
    const { service, prisma } = build();
    prisma.catalogProduct.findUnique.mockResolvedValue({ id: 'cat-1', slug: 'old-slug' });
    prisma.catalogProduct.findFirst.mockResolvedValue(null);

    const result = await service.updateProductSlug('cat-1', '  Testing  ');

    expect(result).toEqual({ id: 'cat-1', slug: 'testing' });
    expect(prisma.catalogProduct.update).toHaveBeenCalledWith({
      where: { id: 'cat-1' },
      data: { slug: 'testing' },
    });
    expect(prisma.seoRedirect.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { fromPath: '/products/old-slug' },
      }),
    );
  });

  it('updateProductSlug rejects a slug another product already uses', async () => {
    const { service, prisma } = build();
    prisma.catalogProduct.findUnique.mockResolvedValue({ id: 'cat-1', slug: 'old-slug' });
    prisma.catalogProduct.findFirst.mockResolvedValue({ id: 'cat-2' });

    await expect(service.updateProductSlug('cat-1', 'testing')).rejects.toThrow(
      ConflictException,
    );
    expect(prisma.catalogProduct.update).not.toHaveBeenCalled();
  });
});
