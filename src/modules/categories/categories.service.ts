import {
  Injectable,
  NotFoundException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { swapPathRedirects } from '../admin/product-slug';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { CreateSubCategoryDto } from './dto/create-subcategory.dto';
import { UpdateSubCategoryDto } from './dto/update-subcategory.dto';
import { BulkCreateCategoryDto } from './dto/bulk-category.dto';
import { BulkCreateSubCategoryDto } from './dto/bulk-category.dto';
import { QuerySubCategoryDto } from './dto/query-subcategory.dto';
import { ReplaceBannersDto } from './dto/replace-banners.dto';

@Injectable()
export class CategoriesService {
  private readonly logger = new Logger(CategoriesService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ──────────────────────────────────────────────
  // CATEGORIES
  // ──────────────────────────────────────────────

  private generateSlug(name: string): string {
    return (
      name
        .trim()
        .toLowerCase()
        // Fold accents to their ASCII base BEFORE the strip below, or the
        // accented letter is deleted outright rather than transliterated:
        // "Pokémon" became "pokmon", a misspelled public URL shipped in the
        // sitemap. NFKD splits "é" into "e" + a combining mark, and the mark
        // is removed here.
        //
        // Deliberately NOT switched to the `slugify` package used elsewhere in
        // this codebase: that would change slug generation for every name, and
        // these slugs are live URLs. This two-line addition is provably inert
        // for plain-ASCII names — see the spec, which pins all 20 current
        // category and sub-category names to their existing slugs.
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
    );
  }

  async createCategory(dto: CreateCategoryDto) {
    const name = dto.name.trim();
    const slug = this.generateSlug(name);

    try {
      const category = await this.prisma.category.create({
        data: {
          name,
          slug,
          image: dto.image,
          // Blank means "no separate phone banner" — store null so the
          // storefront's `mobileImage || image` fallback kicks in.
          mobileImage: dto.mobileImage?.trim() || null,
        },
      });
      this.logger.log(`Category created: ${category.id} - ${name}`);
      return category;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(`Category "${name}" already exists`);
      }
      throw error;
    }
  }

  async findAllCategories() {
    try {
      if ((this.prisma as any).category) {
        const categories = await (this.prisma as any).category.findMany({
          include: {
            subCategories: true,
            bannerImages: { orderBy: [{ order: 'asc' }, { id: 'asc' }] },
          },
          orderBy: { name: 'asc' },
        });
        return categories || [];
      }
    } catch (error) {
      this.logger.warn(`Failed to fetch categories: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
    return [];
  }


  async updateCategory(id: string, dto: UpdateCategoryDto) {
    const existing = await this.prisma.category.findUnique({
      where: { id },
      // Every child's public URL embeds the parent slug
      // (/category/<parentSlug>/<subSlug>), so a parent rename moves them all
      // and each needs its own 301 — see the loop in the transaction below.
      include: { subCategories: { select: { slug: true } } },
    });
    if (!existing) throw new NotFoundException('Category not found');

    const data: Prisma.CategoryUpdateInput = {};
    if (dto.name) {
      data.name = dto.name.trim();
      data.slug = this.generateSlug(dto.name);
    }
    if (dto.image !== undefined) {
      data.image = dto.image;
    }
    // Same omit/clear semantics as mobileImage.
    if (dto.description !== undefined) {
      data.description = dto.description.trim() || null;
    }
    // Omitted leaves the phone banner alone; an empty string clears it and
    // falls back to `image`.
    if (dto.mobileImage !== undefined) {
      data.mobileImage = dto.mobileImage.trim() || null;
    }

    // Renaming changes the slug, which changes the public /category/<slug>
    // URL. Old category URLs don't even 404 — they render an empty grid (a
    // soft-404) — so a rename without a redirect quietly strands the old URL.
    // Same machinery as product/blog slug changes; slugRedirect=false skips
    // only the 301 (shadow cleanup and chain repointing always run).
    const newSlug = typeof data.slug === 'string' ? data.slug : null;
    if (newSlug && newSlug !== existing.slug) {
      const taken = await this.prisma.category.findFirst({
        where: { slug: newSlug, id: { not: id } },
        select: { id: true },
      });
      if (taken) {
        throw new ConflictException(
          `Another collection already uses the URL "${newSlug}"`,
        );
      }
      return this.prisma.$transaction(async (tx) => {
        await swapPathRedirects(
          tx as never,
          `/category/${existing.slug}`,
          `/category/${newSlug}`,
          `auto: category rename (${id})`,
          { createRedirect: dto.slugRedirect },
        );
        // The children move with the parent. Their own slugs are untouched,
        // but the prefix changed, so without these the sub-category URLs are
        // stranded by a rename that looks like it only affected one page.
        for (const sub of existing.subCategories) {
          await swapPathRedirects(
            tx as never,
            `/category/${existing.slug}/${sub.slug}`,
            `/category/${newSlug}/${sub.slug}`,
            `auto: category rename (${id}) — child ${sub.slug}`,
            { createRedirect: dto.slugRedirect },
          );
        }
        return tx.category.update({ where: { id }, data });
      });
    }

    try {
      const updated = await this.prisma.category.update({
        where: { id },
        data,
      });
      this.logger.log(`Category updated: ${id}`);
      return updated;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(`Category "${dto.name}" already exists`);
      }
      throw error;
    }
  }

  async deleteCategory(id: string) {
    const existing = await this.prisma.category.findUnique({
      where: { id },
      include: {
        _count: { select: { masterProducts: true, subCategories: true } },
      },
    });
    if (!existing) throw new NotFoundException('Category not found');

    await this.prisma.category.delete({ where: { id } });
    this.logger.log(`Category deleted: ${id}`);
    return { message: 'Category deleted successfully' };
  }

  async getCategoryMap() {
    const categories = await this.prisma.category.findMany({
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    const map: Record<string, string> = {};
    for (const cat of categories) {
      map[cat.name] = cat.id;
    }
    return map;
  }

  async bulkCreateCategories(dto: BulkCreateCategoryDto) {
    const results = {
      success: 0,
      failed: 0,
      errors: [] as { name: string; reason: string }[],
    };

    for (const item of dto.categories) {
      try {
        await this.createCategory(item);
        results.success++;
      } catch (error) {
        results.failed++;
        results.errors.push({
          name: item.name,
          reason: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    this.logger.log(
      `Bulk category creation: ${results.success} success, ${results.failed} failed`,
    );
    return results;
  }

  // ──────────────────────────────────────────────
  // SUBCATEGORIES
  // ──────────────────────────────────────────────

  async createSubCategory(dto: CreateSubCategoryDto) {
    const name = dto.name.trim();
    const slug = this.generateSlug(name);

    const category = await this.prisma.category.findUnique({
      where: { id: dto.categoryId },
    });
    if (!category) throw new NotFoundException('Category not found');

    try {
      const subCategory = await this.prisma.subCategory.create({
        data: {
          name,
          slug,
          categoryId: dto.categoryId,
        },
        include: { category: true },
      });
      this.logger.log(`SubCategory created: ${subCategory.id} - ${name}`);
      return subCategory;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          `SubCategory "${name}" already exists under this category`,
        );
      }
      throw error;
    }
  }

  async findAllSubCategories(query: QuerySubCategoryDto) {
    try {
      if ((this.prisma as any).subCategory) {
        const where: Prisma.SubCategoryWhereInput = {};
        if (query.categoryId) where.categoryId = query.categoryId;

        const subCategories = await (this.prisma as any).subCategory.findMany({
          where,
          include: {
            category: true,
            bannerImages: { orderBy: [{ order: 'asc' }, { id: 'asc' }] },
          },
          orderBy: { name: 'asc' },
        });
        return subCategories || [];
      }
    } catch (error) {
      this.logger.warn(`Failed to fetch subcategories: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
    return [];
  }


  async updateSubCategory(id: string, dto: UpdateSubCategoryDto) {
    const existing = await this.prisma.subCategory.findUnique({
      where: { id },
      // The public URL is /category/<parentSlug>/<subSlug>, so the redirect
      // below cannot be built without the parent's slug.
      include: { category: { select: { slug: true } } },
    });
    if (!existing) throw new NotFoundException('SubCategory not found');

    const data: Prisma.SubCategoryUpdateInput = {};
    if (dto.name) {
      data.name = dto.name.trim();
      data.slug = this.generateSlug(dto.name);
    }

    // Renaming regenerates the slug, which moves the public
    // /category/<parentSlug>/<subSlug> URL. updateCategory has 301'd its own
    // renames since the redirect machinery landed; sub-categories were missed,
    // so every sub-category rename silently stranded the old URL. Same helper,
    // same slugRedirect=false escape hatch.
    const newSlug = typeof data.slug === 'string' ? data.slug : null;
    const parentSlug = existing.category?.slug;
    if (newSlug && newSlug !== existing.slug && parentSlug) {
      // Sub-category slugs are unique per parent (@@unique([slug, categoryId])),
      // not globally — scope the collision check to this category or a rename
      // that is legal under a different parent is rejected.
      const taken = await this.prisma.subCategory.findFirst({
        where: {
          slug: newSlug,
          categoryId: existing.categoryId,
          id: { not: id },
        },
        select: { id: true },
      });
      if (taken) {
        throw new ConflictException(
          `Another sub-category under this category already uses the URL "${newSlug}"`,
        );
      }
      return this.prisma.$transaction(async (tx) => {
        await swapPathRedirects(
          tx as never,
          `/category/${parentSlug}/${existing.slug}`,
          `/category/${parentSlug}/${newSlug}`,
          `auto: sub-category rename (${id})`,
          { createRedirect: dto.slugRedirect },
        );
        return tx.subCategory.update({
          where: { id },
          data,
          include: { category: true },
        });
      });
    }

    try {
      const updated = await this.prisma.subCategory.update({
        where: { id },
        data,
        include: { category: true },
      });
      this.logger.log(`SubCategory updated: ${id}`);
      return updated;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          `SubCategory "${dto.name}" already exists under this category`,
        );
      }
      throw error;
    }
  }

  async deleteSubCategory(id: string) {
    const existing = await this.prisma.subCategory.findUnique({
      where: { id },
      include: { _count: { select: { masterProducts: true } } },
    });
    if (!existing) throw new NotFoundException('SubCategory not found');

    await this.prisma.subCategory.delete({ where: { id } });
    this.logger.log(`SubCategory deleted: ${id}`);
    return { message: 'SubCategory deleted successfully' };
  }

  // ──────────────────────────────────────────────
  // BANNER SLIDESHOWS
  // ──────────────────────────────────────────────

  /**
   * Atomically replace a category's banner slideshow with the given ordered
   * list (order = array index). Empty array clears the slideshow. The legacy
   * single-image columns (`image`/`mobileImage`) are kept in sync with slide 1
   * so older consumers (admin list thumbnails, pre-slideshow clients) never
   * drift from what the slideshow shows first.
   */
  async replaceCategoryBanners(categoryId: string, dto: ReplaceBannersDto) {
    const existing = await this.prisma.category.findUnique({
      where: { id: categoryId },
    });
    if (!existing) throw new NotFoundException('Category not found');

    const first = dto.banners[0];
    const [, , rows] = await this.prisma.$transaction([
      this.prisma.categoryBannerImage.deleteMany({ where: { categoryId } }),
      this.prisma.category.update({
        where: { id: categoryId },
        data: {
          image: first?.image ?? null,
          mobileImage: first?.mobileImage ?? null,
          bannerImages: {
            create: dto.banners.map((b, index) => ({
              image: b.image,
              mobileImage: b.mobileImage ?? null,
              order: index,
            })),
          },
        },
      }),
      this.prisma.categoryBannerImage.findMany({
        where: { categoryId },
        orderBy: [{ order: 'asc' }, { id: 'asc' }],
      }),
    ]);
    this.logger.log(
      `Category ${categoryId} banners replaced (${dto.banners.length} slides)`,
    );
    return rows;
  }

  /**
   * Same as replaceCategoryBanners, for a sub-category. Sub-categories have no
   * legacy single-image columns, so this only manages the slideshow rows.
   */
  async replaceSubCategoryBanners(subCategoryId: string, dto: ReplaceBannersDto) {
    const existing = await this.prisma.subCategory.findUnique({
      where: { id: subCategoryId },
    });
    if (!existing) throw new NotFoundException('SubCategory not found');

    const [, , rows] = await this.prisma.$transaction([
      this.prisma.categoryBannerImage.deleteMany({ where: { subCategoryId } }),
      this.prisma.categoryBannerImage.createMany({
        data: dto.banners.map((b, index) => ({
          subCategoryId,
          image: b.image,
          mobileImage: b.mobileImage ?? null,
          order: index,
        })),
      }),
      this.prisma.categoryBannerImage.findMany({
        where: { subCategoryId },
        orderBy: [{ order: 'asc' }, { id: 'asc' }],
      }),
    ]);
    this.logger.log(
      `SubCategory ${subCategoryId} banners replaced (${dto.banners.length} slides)`,
    );
    return rows;
  }

  async getSubCategoryMap() {
    const subCategories = await this.prisma.subCategory.findMany({
      select: {
        id: true,
        name: true,
        categoryId: true,
        category: { select: { name: true } },
      },
      orderBy: { name: 'asc' },
    });
    const map: Record<string, string> = {};
    for (const sub of subCategories) {
      // Key format: "CategoryName::SubCategoryName" for disambiguation
      map[`${sub.category.name}::${sub.name}`] = sub.id;
    }
    return map;
  }

  async bulkCreateSubCategories(dto: BulkCreateSubCategoryDto) {
    const results = {
      success: 0,
      failed: 0,
      errors: [] as { name: string; categoryId: string; reason: string }[],
    };

    for (const item of dto.subcategories) {
      try {
        await this.createSubCategory(item);
        results.success++;
      } catch (error) {
        results.failed++;
        results.errors.push({
          name: item.name,
          categoryId: item.categoryId,
          reason: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    this.logger.log(
      `Bulk subcategory creation: ${results.success} success, ${results.failed} failed`,
    );
    return results;
  }
}
