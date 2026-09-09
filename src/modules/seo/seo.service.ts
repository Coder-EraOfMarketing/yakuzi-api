import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, SeoEntityType } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { applySlugChange, SlugPrisma } from '../admin/product-slug';
import {
  ScorableMeta,
  computeAiVisibilityScore,
  computeReadabilityScore,
  computeSeoScore,
  validFaqEntries,
} from './seo-scoring';
import { ListSeoMetaQueryDto, UpsertSeoMetaDto } from './seo.dto';

/**
 * Drops FAQ rows that carry no question or answer.
 *
 * Records written before SeoFaqEntryDto hold one empty array per row the admin
 * typed. Left alone, the SEO editor reloads them as that many blank Q/A boxes
 * — and its save handler reads `row.question.trim()`, which throws on them.
 * Reads return only rows a page could actually render.
 */
function withCleanFaq<T extends { faq?: unknown }>(meta: T): T {
  if (meta.faq == null) return meta;
  const clean = validFaqEntries(meta.faq);
  return { ...meta, faq: clean.length ? clean : null };
}

/** The admin-editable scalar fields — also what a revision restore brings back. */
const EDITABLE_FIELDS = [
  'title',
  'description',
  'canonicalUrl',
  'ogTitle',
  'ogDescription',
  'ogImageUrl',
  'twitterCard',
  'robots',
  'focusKeyword',
  'secondaryKeywords',
  'entityDescription',
  'aiSummary',
  'faq',
  'structuredDataOverride',
  'imageAltOverrides',
] as const;

@Injectable()
export class SeoService {
  constructor(private readonly prisma: PrismaService) {}

  // ─── Product URL slug (catalog-id keyed, same keyspace as PRODUCT SeoMeta) ──
  // The SEO tab's "Canonical URL" field only sets a meta tag; these let the
  // SEO tab change the product's REAL public URL, with the 301-redirect
  // safety net applySlugChange already provides to the product-form editor.

  async getProductSlug(id: string) {
    const product = await this.prisma.catalogProduct.findUnique({
      where: { id },
      select: { id: true, name: true, slug: true },
    });
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }

  async updateProductSlug(
    id: string,
    requestedSlug: string,
    options: { createRedirect?: boolean } = {},
  ) {
    const product = await this.prisma.catalogProduct.findUnique({
      where: { id },
      select: { id: true, slug: true },
    });
    if (!product) throw new NotFoundException('Product not found');
    const slug = await applySlugChange(
      this.prisma as unknown as SlugPrisma,
      product,
      requestedSlug,
      options,
    );
    return { id: product.id, slug };
  }

  /** Public read. Null when no override exists — callers merge fail-open. */
  async getMeta(entityType: SeoEntityType, entityId: string) {
    const meta = await this.prisma.seoMeta.findUnique({
      where: { entityType_entityId: { entityType, entityId } },
    });
    return meta && withCleanFaq(meta);
  }

  async upsertMeta(dto: UpsertSeoMetaDto, userId?: string) {
    const { entityType, entityId, ...raw } = dto;
    const fields = this.normalizeFields(raw);

    const existing = await this.prisma.seoMeta.findUnique({
      where: { entityType_entityId: { entityType, entityId } },
    });

    const scores = this.computeScores({ ...(existing ?? {}), ...fields });

    if (existing) {
      const [, updated] = await this.prisma.$transaction([
        this.prisma.seoMetaRevision.create({
          data: {
            seoMetaId: existing.id,
            snapshot: JSON.parse(JSON.stringify(existing)) as Prisma.InputJsonValue,
            changedById: userId ?? null,
          },
        }),
        this.prisma.seoMeta.update({
          where: { id: existing.id },
          data: { ...fields, ...scores, updatedById: userId ?? null },
        }),
      ]);
      return withCleanFaq(updated);
    }

    const created = await this.prisma.seoMeta.create({
      data: {
        entityType,
        entityId,
        ...fields,
        ...scores,
        updatedById: userId ?? null,
      } as Prisma.SeoMetaUncheckedCreateInput,
    });
    return withCleanFaq(created);
  }

  async listMeta(query: ListSeoMetaQueryDto) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));

    // Types edited at their SOURCE pages (products, collections, blogs) are
    // hidden from the SEO tab's list by default — a row with an Edit button
    // here would contradict the one-editing-surface rule. Their records still
    // exist (the source pages read/write them) and remain reachable by an
    // explicit ?type= query.
    const SOURCE_EDITED = ['PRODUCT', 'CATEGORY', 'SUB_CATEGORY', 'BLOG_POST'] as const;
    const where: Prisma.SeoMetaWhereInput = {
      ...(query.type
        ? { entityType: query.type }
        : { entityType: { notIn: [...SOURCE_EDITED] } }),
      ...(query.missing && { [query.missing]: null }),
      ...(query.search && {
        OR: [
          { entityId: { contains: query.search, mode: 'insensitive' as const } },
          { title: { contains: query.search, mode: 'insensitive' as const } },
        ],
      }),
    };

    const [total, items] = await this.prisma.$transaction([
      this.prisma.seoMeta.count({ where }),
      this.prisma.seoMeta.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return { items, total, page, limit };
  }

  async getRevisions(seoMetaId: string) {
    const meta = await this.prisma.seoMeta.findUnique({ where: { id: seoMetaId } });
    if (!meta) throw new NotFoundException('SEO meta record not found');
    return this.prisma.seoMetaRevision.findMany({
      where: { seoMetaId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  async restoreRevision(seoMetaId: string, revisionId: string, userId?: string) {
    const meta = await this.prisma.seoMeta.findUnique({ where: { id: seoMetaId } });
    if (!meta) throw new NotFoundException('SEO meta record not found');

    const revision = await this.prisma.seoMetaRevision.findUnique({
      where: { id: revisionId },
    });
    if (!revision || revision.seoMetaId !== seoMetaId) {
      throw new NotFoundException('Revision not found');
    }

    const snapshot = revision.snapshot as Record<string, unknown>;
    const fields: Record<string, unknown> = {};
    for (const key of EDITABLE_FIELDS) {
      if (key in snapshot) fields[key] = snapshot[key];
    }
    // Snapshots taken before SeoFaqEntryDto hold the flattened rows; restoring
    // one verbatim would write them back into the live record.
    if ('faq' in fields && fields.faq != null) {
      const clean = validFaqEntries(fields.faq);
      fields.faq = clean.length ? clean : Prisma.DbNull;
    }
    const scores = this.computeScores({ ...meta, ...fields });

    const [, updated] = await this.prisma.$transaction([
      this.prisma.seoMetaRevision.create({
        data: {
          seoMetaId,
          snapshot: JSON.parse(JSON.stringify(meta)) as Prisma.InputJsonValue,
          changedById: userId ?? null,
        },
      }),
      this.prisma.seoMeta.update({
        where: { id: seoMetaId },
        data: { ...fields, ...scores, updatedById: userId ?? null },
      }),
    ]);
    return withCleanFaq(updated);
  }

  /** Trim strings; store '' as null so `missing=` coverage filters stay truthful. */
  private normalizeFields(
    raw: Omit<UpsertSeoMetaDto, 'entityType' | 'entityId'>,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (value === undefined) continue;
      if (key === 'faq') {
        // Only rows a page can render are stored. class-validator lets an
        // array-shaped entry through @ValidateNested, so this is the guarantee
        // that the column never collects blank rows again; an empty result is
        // the admin clearing the FAQ, which is DbNull rather than [].
        const clean = validFaqEntries(value).map((f) => ({
          question: f.question.trim(),
          answer: f.answer.trim(),
        }));
        out[key] = clean.length ? clean : Prisma.DbNull;
      } else if (typeof value === 'string') {
        const trimmed = value.trim();
        out[key] = trimmed === '' ? null : trimmed;
      } else {
        out[key] = value;
      }
    }
    return out;
  }

  private computeScores(merged: Record<string, unknown>) {
    const scorable = merged as ScorableMeta;
    return {
      seoScore: computeSeoScore(scorable),
      aiVisibilityScore: computeAiVisibilityScore(scorable),
      readabilityScore: computeReadabilityScore(scorable),
    };
  }
}
