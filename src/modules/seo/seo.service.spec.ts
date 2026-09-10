import { NotFoundException } from '@nestjs/common';
import { Prisma, SeoEntityType } from '@prisma/client';
import { SeoService } from './seo.service';

describe('SeoService', () => {
  const prisma = {
    seoMeta: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    },
    seoMetaRevision: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
    },
    $transaction: jest.fn(),
  };
  const revalidation = { seoMetaChanged: jest.fn() };
  const service = new SeoService(prisma as never, revalidation as never);

  beforeEach(() => {
    jest.clearAllMocks();
    // Default $transaction behaviour: resolve an array of the given promises
    prisma.$transaction.mockImplementation((ops: Promise<unknown>[]) => Promise.all(ops));
  });

  describe('upsertMeta', () => {
    it('creates a new record with computed scores when none exists', async () => {
      prisma.seoMeta.findUnique.mockResolvedValue(null);
      prisma.seoMeta.create.mockImplementation(({ data }: { data: unknown }) =>
        Promise.resolve(data),
      );

      await service.upsertMeta(
        {
          entityType: SeoEntityType.PRODUCT,
          entityId: 'prod-1',
          title: 'Goku Figure Deluxe Edition',
          focusKeyword: 'goku figure',
        },
        'admin-1',
      );

      const created = prisma.seoMeta.create.mock.calls[0][0].data;
      expect(created.entityType).toBe(SeoEntityType.PRODUCT);
      expect(created.seoScore).toBeGreaterThan(0);
      expect(created.updatedById).toBe('admin-1');
      expect(prisma.seoMetaRevision.create).not.toHaveBeenCalled();
    });

    it('tells the storefront to drop its cache, so the edit is not stuck behind two 5-minute timers', async () => {
      prisma.seoMeta.findUnique.mockResolvedValue(null);
      prisma.seoMeta.create.mockImplementation(({ data }: { data: unknown }) =>
        Promise.resolve(data),
      );

      await service.upsertMeta({
        entityType: SeoEntityType.PRODUCT,
        entityId: 'prod-1',
        title: 'Goku Figure Deluxe Edition',
      });

      expect(revalidation.seoMetaChanged).toHaveBeenCalledWith(
        SeoEntityType.PRODUCT,
        'prod-1',
      );
    });

    it('writes a revision snapshot of the previous state before updating', async () => {
      const existing = {
        id: 'meta-1',
        entityType: SeoEntityType.PRODUCT,
        entityId: 'prod-1',
        title: 'Old title',
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
      };
      prisma.seoMeta.findUnique.mockResolvedValue(existing);
      prisma.seoMeta.update.mockResolvedValue({ ...existing, title: 'New title' });
      prisma.seoMetaRevision.create.mockResolvedValue({});

      await service.upsertMeta(
        { entityType: SeoEntityType.PRODUCT, entityId: 'prod-1', title: 'New title' },
        'admin-1',
      );

      const revisionData = prisma.seoMetaRevision.create.mock.calls[0][0].data;
      expect(revisionData.seoMetaId).toBe('meta-1');
      expect(revisionData.snapshot.title).toBe('Old title');
      const updateArgs = prisma.seoMeta.update.mock.calls[0][0];
      expect(updateArgs.where).toEqual({ id: 'meta-1' });
      expect(updateArgs.data.title).toBe('New title');
    });

    it('normalizes empty strings to null so coverage filters work', async () => {
      prisma.seoMeta.findUnique.mockResolvedValue(null);
      prisma.seoMeta.create.mockImplementation(({ data }: { data: unknown }) =>
        Promise.resolve(data),
      );

      await service.upsertMeta({
        entityType: SeoEntityType.PRODUCT,
        entityId: 'prod-1',
        title: '   ',
        description: '',
      });

      const created = prisma.seoMeta.create.mock.calls[0][0].data;
      expect(created.title).toBeNull();
      expect(created.description).toBeNull();
    });
  });

  describe('getMeta', () => {
    it('returns null (not 404) when there is no override — buyer merges fail-open', async () => {
      prisma.seoMeta.findUnique.mockResolvedValue(null);
      await expect(service.getMeta(SeoEntityType.PRODUCT, 'nope')).resolves.toBeNull();
    });

    it('serves stored FAQ rows untouched', async () => {
      const faq = [{ question: 'In stock?', answer: 'Yes, ships in 48 hours.' }];
      prisma.seoMeta.findUnique.mockResolvedValue({ id: 'meta-1', faq });

      const meta = await service.getMeta(SeoEntityType.PRODUCT, 'prod-1');

      expect(meta?.faq).toEqual(faq);
    });

    it('hides the flattened rows written before the DTO carried @Type()', async () => {
      // What the live records actually hold: one empty array per row typed.
      prisma.seoMeta.findUnique.mockResolvedValue({ id: 'meta-1', faq: [[], [], []] });

      const meta = await service.getMeta(SeoEntityType.PRODUCT, 'prod-1');

      // Not `[]`: the editor would render three blank Q/A boxes and its save
      // handler reads row.question.trim() on them.
      expect(meta?.faq).toBeNull();
    });
  });

  describe('upsertMeta FAQ handling', () => {
    it('stores well-formed entries', async () => {
      const faq = [{ question: 'In stock?', answer: 'Yes, ships in 48 hours.' }];
      prisma.seoMeta.findUnique.mockResolvedValue(null);
      prisma.seoMeta.create.mockImplementation(({ data }: { data: unknown }) =>
        Promise.resolve(data),
      );

      await service.upsertMeta({
        entityType: SeoEntityType.PRODUCT,
        entityId: 'prod-1',
        faq,
      });

      expect(prisma.seoMeta.create.mock.calls[0][0].data.faq).toEqual(faq);
    });

    it('never writes rows without a question and an answer', async () => {
      prisma.seoMeta.findUnique.mockResolvedValue(null);
      prisma.seoMeta.create.mockImplementation(({ data }: { data: unknown }) =>
        Promise.resolve(data),
      );

      await service.upsertMeta({
        entityType: SeoEntityType.PRODUCT,
        entityId: 'prod-1',
        faq: [{ question: 'Orphan question', answer: '  ' }] as never,
      });

      // DbNull, not []: a nullable Json column needs the sentinel.
      expect(prisma.seoMeta.create.mock.calls[0][0].data.faq).toBe(Prisma.DbNull);
    });
  });

  describe('listMeta', () => {
    it('filters by missing field using null', async () => {
      prisma.seoMeta.count.mockResolvedValue(0);
      prisma.seoMeta.findMany.mockResolvedValue([]);

      await service.listMeta({ missing: 'title' });

      const where = prisma.seoMeta.count.mock.calls[0][0].where;
      expect(where.title).toBeNull();
    });
  });

  describe('restoreRevision', () => {
    it('404s when the revision does not belong to the meta record', async () => {
      prisma.seoMeta.findUnique.mockResolvedValue({ id: 'meta-1' });
      prisma.seoMetaRevision.findUnique.mockResolvedValue({
        id: 'rev-1',
        seoMetaId: 'other-meta',
        snapshot: {},
      });

      await expect(service.restoreRevision('meta-1', 'rev-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('restores editable fields from the snapshot and recomputes scores', async () => {
      const current = {
        id: 'meta-1',
        entityType: SeoEntityType.PRODUCT,
        entityId: 'prod-1',
        title: 'Current title',
      };
      prisma.seoMeta.findUnique.mockResolvedValue(current);
      prisma.seoMetaRevision.findUnique.mockResolvedValue({
        id: 'rev-1',
        seoMetaId: 'meta-1',
        snapshot: {
          id: 'meta-1',
          entityType: 'PRODUCT',
          entityId: 'prod-1',
          title: 'Snapshot title',
          seoScore: 999, // must NOT be restored verbatim — recomputed instead
        },
      });
      prisma.seoMeta.update.mockResolvedValue({});
      prisma.seoMetaRevision.create.mockResolvedValue({});

      await service.restoreRevision('meta-1', 'rev-1', 'admin-1');

      const updateData = prisma.seoMeta.update.mock.calls[0][0].data;
      expect(updateData.title).toBe('Snapshot title');
      expect(updateData.seoScore).not.toBe(999);
      // current state snapshotted before restore
      const revisionData = prisma.seoMetaRevision.create.mock.calls[0][0].data;
      expect(revisionData.snapshot.title).toBe('Current title');
    });
  });
});
