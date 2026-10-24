import { NotFoundException } from '@nestjs/common';
import { CategoriesService } from './categories.service';
import type { ReplaceBannersDto } from './dto/replace-banners.dto';

const slides = (dto: Partial<ReplaceBannersDto> = {}): ReplaceBannersDto =>
  ({
    banners: [
      { image: 'https://cdn/a-desktop.jpg', mobileImage: 'https://cdn/a-mobile.jpg' },
      { image: 'https://cdn/b-desktop.jpg' },
    ],
    ...dto,
  }) as ReplaceBannersDto;

const build = ({
  category = { id: 'cat-1', name: 'Books' } as unknown,
  subCategory = { id: 'sub-1', name: 'Manga' } as unknown,
  rows = [] as unknown[],
} = {}) => {
  const prisma = {
    category: {
      findUnique: jest.fn().mockResolvedValue(category),
      update: jest.fn().mockResolvedValue({}),
    },
    subCategory: {
      findUnique: jest.fn().mockResolvedValue(subCategory),
    },
    categoryBannerImage: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      findMany: jest.fn().mockResolvedValue(rows),
    },
    $transaction: jest.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  const service = new CategoriesService(prisma as never);
  return { service, prisma };
};

describe('CategoriesService.replaceCategoryBanners', () => {
  it('throws 404 when the category does not exist', async () => {
    const { service } = build({ category: null });
    await expect(
      service.replaceCategoryBanners('missing', slides()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('deletes existing rows and recreates them with order = array index', async () => {
    const { service, prisma } = build();
    await service.replaceCategoryBanners('cat-1', slides());

    expect(prisma.categoryBannerImage.deleteMany).toHaveBeenCalledWith({
      where: { categoryId: 'cat-1' },
    });
    const updateArg = prisma.category.update.mock.calls[0][0];
    expect(updateArg.data.bannerImages.create).toEqual([
      { image: 'https://cdn/a-desktop.jpg', mobileImage: 'https://cdn/a-mobile.jpg', order: 0 },
      { image: 'https://cdn/b-desktop.jpg', mobileImage: null, order: 1 },
    ]);
  });

  it('keeps the legacy single-image columns in sync with slide 1', async () => {
    const { service, prisma } = build();
    await service.replaceCategoryBanners('cat-1', slides());

    const updateArg = prisma.category.update.mock.calls[0][0];
    expect(updateArg.data.image).toBe('https://cdn/a-desktop.jpg');
    expect(updateArg.data.mobileImage).toBe('https://cdn/a-mobile.jpg');
  });

  it('an empty array clears the slideshow AND the legacy columns', async () => {
    const { service, prisma } = build();
    await service.replaceCategoryBanners('cat-1', slides({ banners: [] }));

    const updateArg = prisma.category.update.mock.calls[0][0];
    expect(updateArg.data.image).toBeNull();
    expect(updateArg.data.mobileImage).toBeNull();
    expect(updateArg.data.bannerImages.create).toEqual([]);
  });

  it('returns the freshly ordered rows', async () => {
    const expected = [{ id: 'r1', image: 'x', mobileImage: null, order: 0 }];
    const { service, prisma } = build({ rows: expected });
    const result = await service.replaceCategoryBanners('cat-1', slides());

    expect(result).toBe(expected);
    expect(prisma.categoryBannerImage.findMany).toHaveBeenCalledWith({
      where: { categoryId: 'cat-1' },
      orderBy: [{ order: 'asc' }, { id: 'asc' }],
    });
  });
});

describe('CategoriesService.replaceSubCategoryBanners', () => {
  it('throws 404 when the sub-category does not exist', async () => {
    const { service } = build({ subCategory: null });
    await expect(
      service.replaceSubCategoryBanners('missing', slides()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('replaces rows scoped to the sub-category with order = array index', async () => {
    const { service, prisma } = build();
    await service.replaceSubCategoryBanners('sub-1', slides());

    expect(prisma.categoryBannerImage.deleteMany).toHaveBeenCalledWith({
      where: { subCategoryId: 'sub-1' },
    });
    expect(prisma.categoryBannerImage.createMany).toHaveBeenCalledWith({
      data: [
        { subCategoryId: 'sub-1', image: 'https://cdn/a-desktop.jpg', mobileImage: 'https://cdn/a-mobile.jpg', order: 0 },
        { subCategoryId: 'sub-1', image: 'https://cdn/b-desktop.jpg', mobileImage: null, order: 1 },
      ],
    });
    // never touches the parent category's legacy columns
    expect(prisma.category.update).not.toHaveBeenCalled();
  });
});

describe('CategoriesService.updateCategory — description intro copy', () => {
  it('trims and stores the description', async () => {
    const { service, prisma } = build();

    await service.updateCategory('cat-1', {
      description: '  Authentic figurines from verified sellers.  ',
    } as never);

    expect(prisma.category.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'cat-1' },
        data: expect.objectContaining({
          description: 'Authentic figurines from verified sellers.',
        }),
      }),
    );
  });

  it('clears the description on empty string, leaves it untouched when omitted', async () => {
    const { service, prisma } = build();

    await service.updateCategory('cat-1', { description: '' } as never);
    const cleared = prisma.category.update.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(cleared.data.description).toBeNull();

    await service.updateCategory('cat-1', { image: 'x.png' } as never);
    const untouched = prisma.category.update.mock.calls[1][0] as {
      data: Record<string, unknown>;
    };
    expect('description' in untouched.data).toBe(false);
  });
});

describe('CategoriesService.updateCategory — rename creates a category URL redirect', () => {
  const buildForRename = () => {
    const prisma = {
      category: {
        findUnique: jest.fn().mockResolvedValue({ id: 'cat-1', name: 'Figurines', slug: 'figurines', subCategories: [] }),
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({}),
      },
      seoRedirect: {
        deleteMany: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({}),
        upsert: jest.fn().mockResolvedValue({}),
      },
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
    };
    const service = new CategoriesService(prisma as never);
    return { service, prisma };
  };

  it('301s the old category URL when a rename changes the slug', async () => {
    const { service, prisma } = buildForRename();

    await service.updateCategory('cat-1', { name: 'Figures' } as never);

    const upsert = prisma.seoRedirect.upsert.mock.calls[0][0] as {
      where: { fromPath: string };
      create: { toPath: string; statusCode: number };
    };
    expect(upsert.where).toEqual({ fromPath: '/category/figurines' });
    expect(upsert.create.toPath).toBe('/category/figures');
    expect(upsert.create.statusCode).toBe(301);
    expect(prisma.category.update).toHaveBeenCalled();
  });

  it('skips only the 301 when slugRedirect is false', async () => {
    const { service, prisma } = buildForRename();

    await service.updateCategory('cat-1', { name: 'Figures', slugRedirect: false } as never);

    expect(prisma.seoRedirect.upsert).not.toHaveBeenCalled();
    expect(prisma.category.update).toHaveBeenCalled();
  });

  it('creates no redirect when only the image changes (slug untouched)', async () => {
    const { service, prisma } = buildForRename();

    await service.updateCategory('cat-1', { image: 'x.png' } as never);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.seoRedirect.upsert).not.toHaveBeenCalled();
  });

  it('rejects a rename whose slug collides with another collection', async () => {
    const { service, prisma } = buildForRename();
    prisma.category.findFirst.mockResolvedValue({ id: 'cat-2' });

    await expect(service.updateCategory('cat-1', { name: 'Books' } as never)).rejects.toThrow(
      'already uses the URL',
    );
  });
});

describe('CategoriesService.updateCategory — rename combined with other edits', () => {
  it('carries description/image edits into the rename transaction (no silent drop)', async () => {
    const prisma = {
      category: {
        findUnique: jest.fn().mockResolvedValue({ id: 'cat-1', name: 'Figurines', slug: 'figurines', subCategories: [] }),
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({}),
      },
      seoRedirect: {
        deleteMany: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({}),
        upsert: jest.fn().mockResolvedValue({}),
      },
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
    };
    const service = new CategoriesService(prisma as never);

    await service.updateCategory('cat-1', {
      name: 'Figures',
      description: 'New intro copy.',
      image: 'new.png',
    } as never);

    const update = prisma.category.update.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(update.data.slug).toBe('figures');
    expect(update.data.description).toBe('New intro copy.');
    expect(update.data.image).toBe('new.png');
    expect(prisma.seoRedirect.upsert).toHaveBeenCalled();
  });
});

describe('CategoriesService.generateSlug — accent folding', () => {
  // generateSlug is private; it is pure, so call it directly rather than
  // driving it through a mocked create/update for every case.
  const slug = (name: string): string =>
    (new CategoriesService({} as never) as never as {
      generateSlug(n: string): string;
    }).generateSlug(name);

  it('transliterates accents instead of deleting them', () => {
    // The bug: "é" was stripped by the [^a-z0-9\s-] class, so the live URL
    // shipped as /category/trading-cards/pokmon while the heading rendered
    // "Pokémon".
    expect(slug('Pokémon')).toBe('pokemon');
  });

  it('handles other common diacritics', () => {
    expect(slug('Café')).toBe('cafe');
    expect(slug('Naïve')).toBe('naive');
    expect(slug('Pokémon Café')).toBe('pokemon-cafe');
  });

  // Load-bearing: these are live URLs. The accent fold must be inert for every
  // name currently in the database, or renaming any of them silently moves a
  // public page. Pulled from /api/products/categories on 2026-10-24.
  it.each([
    ['Books', 'books'],
    ['Collectables', 'collectables'],
    ['Cosplay & Props', 'cosplay-props'],
    ['Die-Cast', 'die-cast'],
    ['Figurines', 'figurines'],
    ['Funko Pop', 'funko-pop'],
    ['Gaming', 'gaming'],
    ['Merch', 'merch'],
    ['Pre-Order', 'pre-order'],
    ['Trading Cards', 'trading-cards'],
    ['General', 'general'],
    ['Anime & Manga', 'anime-manga'],
    ['Comics', 'comics'],
    ['Figures & Statues', 'figures-statues'],
    ['Head Gear', 'head-gear'],
    ['Hot Wheels', 'hot-wheels'],
    ['Action Figures', 'action-figures'],
    ['Anime', 'anime'],
    ['Keyboard Skins', 'keyboard-skins'],
    ['Desk Toys', 'desk-toys'],
    ['Wall Hanging', 'wall-hanging'],
  ])('leaves the existing slug for %s unchanged', (name, expected) => {
    expect(slug(name)).toBe(expected);
  });
});

describe('CategoriesService.updateSubCategory — rename creates a URL redirect', () => {
  const buildForSubRename = (subCategories: unknown[] = []) => {
    const prisma = {
      subCategory: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'sub-1',
          name: 'Pokémon',
          slug: 'pokmon',
          categoryId: 'cat-1',
          category: { slug: 'trading-cards' },
        }),
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({}),
      },
      seoRedirect: {
        deleteMany: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({}),
        upsert: jest.fn().mockResolvedValue({}),
      },
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
    };
    void subCategories;
    const service = new CategoriesService(prisma as never);
    return { service, prisma };
  };

  it('301s the old sub-category URL, nesting it under the parent slug', async () => {
    const { service, prisma } = buildForSubRename();

    await service.updateSubCategory('sub-1', { name: 'Pokemon' } as never);

    const upsert = prisma.seoRedirect.upsert.mock.calls[0][0] as {
      where: { fromPath: string };
      create: { toPath: string; statusCode: number };
    };
    expect(upsert.where).toEqual({ fromPath: '/category/trading-cards/pokmon' });
    expect(upsert.create.toPath).toBe('/category/trading-cards/pokemon');
    expect(upsert.create.statusCode).toBe(301);
    expect(prisma.subCategory.update).toHaveBeenCalled();
  });

  it('loads the parent slug — the redirect path cannot be built without it', async () => {
    const { service, prisma } = buildForSubRename();

    await service.updateSubCategory('sub-1', { name: 'Pokemon' } as never);

    // Asserting the QUERY, not the result: a mock returns whatever the test
    // built, so dropping the include would leave every behavioural test green.
    const args = prisma.subCategory.findUnique.mock.calls[0][0] as {
      include?: { category?: unknown };
    };
    expect(args.include?.category).toBeTruthy();
  });

  it('scopes the collision check to the parent category', async () => {
    const { service, prisma } = buildForSubRename();

    await service.updateSubCategory('sub-1', { name: 'Pokemon' } as never);

    // Sub-slugs are unique per parent (@@unique([slug, categoryId])), so an
    // unscoped check would reject a rename that is legal under another parent.
    const where = prisma.subCategory.findFirst.mock.calls[0][0] as {
      where: { categoryId?: string };
    };
    expect(where.where.categoryId).toBe('cat-1');
  });

  it('skips only the 301 when slugRedirect is false', async () => {
    const { service, prisma } = buildForSubRename();

    await service.updateSubCategory('sub-1', {
      name: 'Pokemon',
      slugRedirect: false,
    } as never);

    expect(prisma.seoRedirect.upsert).not.toHaveBeenCalled();
    expect(prisma.subCategory.update).toHaveBeenCalled();
  });

  it('rejects a rename colliding with a sibling under the same parent', async () => {
    const { service, prisma } = buildForSubRename();
    prisma.subCategory.findFirst.mockResolvedValue({ id: 'sub-2' });

    await expect(
      service.updateSubCategory('sub-1', { name: 'Pokemon' } as never),
    ).rejects.toThrow('already uses the URL');
  });

  it('creates no redirect when the name does not change the slug', async () => {
    const { service, prisma } = buildForSubRename();

    await service.updateSubCategory('sub-1', { name: 'Pokmon' } as never);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.seoRedirect.upsert).not.toHaveBeenCalled();
  });
});

describe('CategoriesService.updateCategory — a parent rename moves its children too', () => {
  const buildWithChildren = () => {
    const prisma = {
      category: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'cat-1',
          name: 'Figurines',
          slug: 'figurines',
          subCategories: [{ slug: 'action-figures' }, { slug: 'anime' }],
        }),
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({}),
      },
      seoRedirect: {
        deleteMany: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({}),
        upsert: jest.fn().mockResolvedValue({}),
      },
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
    };
    const service = new CategoriesService(prisma as never);
    return { service, prisma };
  };

  it('301s every child URL under the new parent slug', async () => {
    const { service, prisma } = buildWithChildren();

    await service.updateCategory('cat-1', { name: 'Figures' } as never);

    const pairs = prisma.seoRedirect.upsert.mock.calls.map(
      (c) =>
        [
          (c[0] as { where: { fromPath: string } }).where.fromPath,
          (c[0] as { create: { toPath: string } }).create.toPath,
        ] as const,
    );
    expect(pairs).toEqual([
      ['/category/figurines', '/category/figures'],
      ['/category/figurines/action-figures', '/category/figures/action-figures'],
      ['/category/figurines/anime', '/category/figures/anime'],
    ]);
  });

  it('loads the children — without the include they are silently skipped', async () => {
    const { service, prisma } = buildWithChildren();

    await service.updateCategory('cat-1', { name: 'Figures' } as never);

    const args = prisma.category.findUnique.mock.calls[0][0] as {
      include?: { subCategories?: unknown };
    };
    expect(args.include?.subCategories).toBeTruthy();
  });
});
