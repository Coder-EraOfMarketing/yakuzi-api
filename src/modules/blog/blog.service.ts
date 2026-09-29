import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { swapPathRedirects } from '../admin/product-slug';
import { Prisma, BlogStatus, BlogCategory, BlogAuthor, BlogPost } from '@prisma/client';
import {
  CreateBlogPostDto,
  UpdateBlogPostDto,
  UpdateBlogStatusDto,
  QueryBlogDto,
  CreateBlogAuthorDto,
  UpdateBlogAuthorDto,
  CreateBlogCategoryDto,
  UpdateBlogCategoryDto,
} from './dto';

/**
 * Turn a unique-constraint violation on blog_categories into something an
 * admin can act on.
 *
 * Unhandled, Prisma's own message reached the browser verbatim:
 *
 *   Invalid `this.prisma.blogCategory.create()` invocation in
 *   /home/yukizi_deploy/yakuzi-api/src/modules/blog/blog.service.ts:494:37
 *   491 .replace(/ /g, '-')  …
 *   Unique constraint failed on the fields: (`name`)
 *
 * — which discloses the deployment path and the surrounding source, and still
 * does not tell the admin that a category by that name already exists.
 *
 * Both `name` and `slug` are unique, and they fail for different reasons: two
 * visibly different names ("Anime News" and "Anime news") collapse to the same
 * slug, so saying which one collided is the difference between "rename it" and
 * "it is already there".
 */
function duplicateBlogCategory(error: unknown, name: string, slug: string): unknown {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== 'P2002'
  ) {
    return error;
  }
  const target = error.meta?.target;
  const fields = Array.isArray(target) ? target.map(String) : [String(target ?? '')];
  if (fields.some((f) => f.includes('slug'))) {
    return new ConflictException(
      `Another category already uses the URL "${slug}". Give this one a different name or slug.`,
    );
  }
  return new ConflictException(
    `A category called "${name}" already exists — pick it from the list instead of creating it again.`,
  );
}

/**
 * The credited authors / filed categories of a post, in byline order, with
 * the primary first.
 *
 * `authorId` and `categoryId` remain the primary of each — the byline's first
 * name, and the category that owns the post's articleSection — so a caller
 * that knows nothing about the join tables still reads a correct post. This
 * normalises whichever the caller sent: a list, a single id, or both.
 */
export function orderedIds(
  list: string[] | undefined,
  primary: string | null | undefined,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of [primary, ...(list ?? [])]) {
    const value = typeof id === 'string' ? id.trim() : '';
    if (value && !seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

/** Rows for a join table, position 0 first. */
const linkRows = (ids: string[], key: 'authorId' | 'categoryId') =>
  ids.map((id, position) => ({ [key]: id, position }));

/**
 * Everything a rendered post needs, in one place so the sets cannot be
 * included on some reads and missed on others — a byline that shows one
 * author on the post page and three on the index is worse than no byline.
 */
export const POST_INCLUDE = {
  author: true,
  category: true,
  authors: { include: { author: true }, orderBy: { position: 'asc' as const } },
  categories: {
    include: { category: true },
    orderBy: { position: 'asc' as const },
  },
};

@Injectable()
export class BlogService {
  constructor(private readonly prisma: PrismaService) {}

  // ──────────────────────────────────────────────
  // BLOG POSTS (ADMIN)
  // ──────────────────────────────────────────────

  async createPost(dto: CreateBlogPostDto, authorUserId?: string) {
    const {
      title,
      slug,
      excerpt,
      content,
      featuredImage,
      images,
      authorId,
      categoryId,
      tags,
      status,
      metaTitle,
      metaDescription,
      metaKeywords,
      canonicalUrl,
      ogImage,
    } = dto;

    let finalAuthorId = authorId;

    // If authorId is not provided (though required in DTO, might be any/legacy call),
    // try to find/create author from user
    if (!finalAuthorId && authorUserId) {
      const user = await this.prisma.user.findUnique({
        where: { id: authorUserId },
        include: { adminProfile: true },
      });

      if (user) {
        let author = await this.prisma.blogAuthor.findFirst({
          where: { name: user.adminProfile?.displayName || 'Admin' },
        });

        if (!author) {
          author = await this.prisma.blogAuthor.create({
            data: {
              name: user.adminProfile?.displayName || 'Admin',
              bio: 'Yukizi Admin',
              avatar: '',
            },
          });
        }
        finalAuthorId = author.id;
      }
    }

    if (!finalAuthorId) {
      throw new BadRequestException('Author ID is required');
    }

    const finalSlug =
      slug ||
      title
        .toLowerCase()
        .trim()
        .replace(/[^\w\s-]/g, '')
        .replace(/[\s_-]+/g, '-')
        .replace(/^-+|-+$/g, '');

    // Check if slug already exists
    const existingPost = await this.prisma.blogPost.findUnique({
      where: { slug: finalSlug },
    });

    if (existingPost) {
      throw new BadRequestException(
        'A blog post with this slug already exists',
      );
    }

    let finalContent = content;
    if (typeof content === 'string' && content.trim().startsWith('{')) {
      try {
        finalContent = JSON.parse(content);
      } catch (e) {
        // Fallback to original content
      }
    }

    const createData: any = {
      title,
      slug: finalSlug,
      excerpt: excerpt || '',
      content: finalContent || {},
      featuredImage,
      images: images || [],
      author: { connect: { id: finalAuthorId } },
      tags: tags || [],
      status: status || BlogStatus.DRAFT,
      metaTitle,
      metaDescription,
      metaKeywords: metaKeywords || [],
      canonicalUrl,
      ogImage,
      publishedAt: status === BlogStatus.PUBLISHED ? new Date() : null,
    };

    // The primary stays the first of each list, so a post created with
    // authorIds: [a, b] reads as authored by `a` to anything that only knows
    // about the scalar column.
    const authorIds = orderedIds(dto.authorIds, finalAuthorId);
    const categoryIds = orderedIds(dto.categoryIds, categoryId);
    const primaryCategoryId = categoryIds[0];

    if (primaryCategoryId) {
      createData.category = { connect: { id: primaryCategoryId } };
    }
    createData.authors = { create: linkRows(authorIds, 'authorId') };
    if (categoryIds.length) {
      createData.categories = { create: linkRows(categoryIds, 'categoryId') };
    }

    return this.prisma.blogPost.create({
      data: createData,
      include: POST_INCLUDE,
    });
  }

  async adminGetAllPosts(query: QueryBlogDto) {
    const { categoryId, status, search, limit = 10, page = 1 } = query;
    const skip = (page - 1) * limit;

    const where = {
      // Filed under it primarily OR as an additional category — a post in
      // two categories must appear under both, or the second is decorative.
      ...(categoryId && {
        OR: [{ categoryId }, { categories: { some: { categoryId } } }],
      }),
      ...(status && { status }),
      ...(search && {
        OR: [
          { title: { contains: search, mode: 'insensitive' as any } },
          { excerpt: { contains: search, mode: 'insensitive' as any } },
        ],
      }),
    };

    const [items, total] = await Promise.all([
      this.prisma.blogPost.findMany({
        where,
        include: POST_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.blogPost.count({ where }),
    ]);

    return {
      items,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async adminGetPostById(id: string) {
    const post = await this.prisma.blogPost.findUnique({
      where: { id },
      include: POST_INCLUDE,
    });

    if (!post) {
      throw new NotFoundException(`Blog post with ID ${id} not found`);
    }

    return post;
  }

  async updatePost(id: string, dto: UpdateBlogPostDto) {
    const existing = await this.prisma.blogPost.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Blog post not found');

    // None of these are BlogPost columns — consumed here, never persisted.
    const { status, createRedirect, authorIds, categoryIds, ...fields } = dto;

    // Only rewrite a set the caller actually sent. An update that touches
    // only the title must not silently strip a post's co-authors.
    // A list that is sent IS the list. Folding the existing primary back in
    // would make removing an author impossible, and the editor always sends
    // the full set. Only an explicitly-sent `authorId`/`categoryId` in the
    // same request takes first place.
    const taxonomy: Record<string, unknown> = {};
    if (authorIds !== undefined) {
      const ids = orderedIds(authorIds, fields.authorId);
      if (!ids.length) {
        throw new BadRequestException('A post needs at least one author');
      }
      fields.authorId = ids[0];
      taxonomy.authors = {
        deleteMany: {},
        create: linkRows(ids, 'authorId'),
      };
    }
    if (categoryIds !== undefined) {
      const ids = orderedIds(categoryIds, fields.categoryId);
      // A post can legitimately end up with no category: the column is
      // nullable and the storefront treats it as unfiled. It must not keep
      // pointing at a category the post is no longer in.
      fields.categoryId = ids[0] ?? null;
      taxonomy.categories = {
        deleteMany: {},
        create: linkRows(ids, 'categoryId'),
      };
    }

    let publishedAt = existing.publishedAt;
    if (
      status === BlogStatus.PUBLISHED &&
      existing.status !== BlogStatus.PUBLISHED
    ) {
      publishedAt = new Date();
    } else if (status === BlogStatus.DRAFT) {
      publishedAt = null;
    }

    // Changing the slug changes the post's public URL — mirror the product
    // pipeline: uniqueness check, shadow cleanup, chain repointing, and
    // (unless the editor opted out) a 301 from the old URL. All in one
    // transaction with the update itself.
    const slugChanged =
      typeof fields.slug === 'string' &&
      fields.slug.trim() !== '' &&
      fields.slug !== existing.slug;
    if (slugChanged) {
      const taken = await this.prisma.blogPost.findFirst({
        where: { slug: fields.slug, id: { not: id } },
        select: { id: true },
      });
      if (taken) {
        throw new ConflictException(
          'A blog post with this slug already exists',
        );
      }
      return this.prisma.$transaction(async (tx) => {
        await swapPathRedirects(
          tx as never,
          `/blogs/${existing.slug}`,
          `/blogs/${fields.slug}`,
          `auto: blog slug change (${id})`,
          { createRedirect },
        );
        return tx.blogPost.update({
          where: { id },
          data: { ...fields, ...taxonomy, status, publishedAt },
          include: POST_INCLUDE,
        });
      });
    }

    return this.prisma.blogPost.update({
      where: { id },
      data: {
        ...fields,
        ...taxonomy,
        status,
        publishedAt,
      },
      include: POST_INCLUDE,
    });
  }

  async updatePostStatus(id: string, dto: UpdateBlogStatusDto) {
    const existing = await this.prisma.blogPost.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Blog post not found');

    const { status } = dto;

    let publishedAt = existing.publishedAt;
    if (
      status === BlogStatus.PUBLISHED &&
      existing.status !== BlogStatus.PUBLISHED
    ) {
      publishedAt = new Date();
    } else if (status === BlogStatus.DRAFT) {
      publishedAt = null;
    }

    return this.prisma.blogPost.update({
      where: { id },
      data: {
        status,
        publishedAt,
      },
    });
  }

  async deletePost(id: string) {
    const existing = await this.prisma.blogPost.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Blog post not found');

    return this.prisma.blogPost.delete({ where: { id } });
  }

  // ──────────────────────────────────────────────
  // BLOG POSTS (PUBLIC)
  // ──────────────────────────────────────────────

  async getPublishedPosts(query: QueryBlogDto) {
    const { categoryId, search, limit = 10, page = 1 } = query;
    const skip = (page - 1) * limit;

    const where = {
      status: BlogStatus.PUBLISHED,
      // Filed under it primarily OR as an additional category — a post in
      // two categories must appear under both, or the second is decorative.
      ...(categoryId && {
        OR: [{ categoryId }, { categories: { some: { categoryId } } }],
      }),
      ...(search && {
        OR: [
          { title: { contains: search, mode: 'insensitive' as any } },
          { excerpt: { contains: search, mode: 'insensitive' as any } },
        ],
      }),
    };

    const [items, total] = await Promise.all([
      this.prisma.blogPost.findMany({
        where,
        include: POST_INCLUDE,
        orderBy: { publishedAt: 'desc' },
        skip,
        take: Number(limit),
      }),
      this.prisma.blogPost.count({ where }),
    ]);

    return {
      items,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getTrendingPosts(limit: number = 10) {
    return this.prisma.blogPost.findMany({
      where: { status: BlogStatus.PUBLISHED },
      include: POST_INCLUDE,
      orderBy: { views: 'desc' },
      take: Number(limit),
    });
  }

  async getPostsByTag(tag: string, query: QueryBlogDto) {
    const { limit = 10, page = 1 } = query;
    const skip = (page - 1) * limit;

    const where = {
      status: BlogStatus.PUBLISHED,
      tags: { has: tag },
    };

    const [items, total] = await Promise.all([
      this.prisma.blogPost.findMany({
        where,
        include: POST_INCLUDE,
        orderBy: { publishedAt: 'desc' },
        skip,
        take: Number(limit),
      }),
      this.prisma.blogPost.count({ where }),
    ]);

    return {
      items,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getPostBySlug(slug: string) {
    const post = await this.prisma.blogPost.findUnique({
      where: { slug },
      include: POST_INCLUDE,
    });

    if (!post || post.status !== BlogStatus.PUBLISHED) {
      throw new NotFoundException(`Blog post with slug ${slug} not found`);
    }

    // Return post (view increment usually handled separately to avoid locking or in background)
    return post;
  }

  async incrementViews(slug: string) {
    return this.prisma.blogPost.update({
      where: { slug },
      data: { views: { increment: 1 } },
    });
  }

  async getSitemapData() {
    return this.prisma.blogPost.findMany({
      where: { status: BlogStatus.PUBLISHED },
      select: {
        slug: true,
        publishedAt: true,
        updatedAt: true,
      },
      orderBy: { publishedAt: 'desc' },
    });
  }

  // ──────────────────────────────────────────────
  // AUTHORS
  // ──────────────────────────────────────────────

  async createAuthor(dto: CreateBlogAuthorDto) {
    return this.prisma.blogAuthor.create({
      data: dto,
    });
  }

  async getAllAuthors() {
    return this.prisma.blogAuthor.findMany({
      include: {
        _count: {
          select: { posts: true },
        },
      },
      orderBy: { name: 'asc' },
    });
  }

  async getAuthorById(id: string) {
    const author = await this.prisma.blogAuthor.findUnique({
      where: { id },
      include: {
        _count: {
          select: { posts: true },
        },
      },
    });

    if (!author) throw new NotFoundException('Author not found');
    return author;
  }

  async updateAuthor(id: string, dto: UpdateBlogAuthorDto) {
    const existing = await this.prisma.blogAuthor.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Author not found');

    return this.prisma.blogAuthor.update({
      where: { id },
      data: dto,
    });
  }

  async deleteAuthor(id: string) {
    const existing = await this.prisma.blogAuthor.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Author not found');

    // Any post they are credited on, not just the ones they are primary
    // author of. The join row cascades on delete, so without this an author
    // could be removed from three bylines without a word.
    const postCount = await this.prisma.blogPost.count({
      where: { OR: [{ authorId: id }, { authors: { some: { authorId: id } } }] },
    });
    if (postCount > 0) {
      throw new BadRequestException(
        'Cannot delete author with existing blog posts',
      );
    }

    return this.prisma.blogAuthor.delete({ where: { id } });
  }

  // ──────────────────────────────────────────────
  // CATEGORIES
  // ──────────────────────────────────────────────

  async createCategory(dto: CreateBlogCategoryDto) {
    const { name, slug } = dto;
    const finalSlug =
      slug ||
      name
        .toLowerCase()
        .replace(/ /g, '-')
        .replace(/[^\w-]+/g, '');

    try {
      return await this.prisma.blogCategory.create({
        data: {
          name,
          slug: finalSlug,
        },
      });
    } catch (error) {
      // Both name and slug are @unique. Unhandled, Prisma's own message went
      // to the browser verbatim — including the deployed source path and the
      // lines around the call — and told an admin nothing about what to do.
      throw duplicateBlogCategory(error, name, finalSlug);
    }
  }

  /**
   * @param countAllPosts count drafts too.
   *
   * The public storefront wants the published count — a category listing page
   * showing "4 posts" and then rendering one is wrong. An admin needs the
   * total, because deleteCategory below refuses on ANY post, drafts included:
   * with the published-only count, a category holding three drafts reported
   * "0 posts", the admin panel offered a delete button for it, and the API
   * then rejected the delete it had just invited.
   */
  async getAllCategories(countAllPosts = false) {
    return this.prisma.blogCategory.findMany({
      include: {
        _count: {
          select: {
            posts: countAllPosts
              ? true
              : { where: { status: BlogStatus.PUBLISHED } },
          },
        },
      },
      orderBy: { name: 'asc' },
    });
  }

  async updateCategory(id: string, dto: UpdateBlogCategoryDto) {
    const existing = await this.prisma.blogCategory.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundException('Category not found');

    try {
      return await this.prisma.blogCategory.update({
        where: { id },
        data: dto,
      });
    } catch (error) {
      throw duplicateBlogCategory(error, dto.name ?? existing.name, dto.slug ?? existing.slug);
    }
  }

  async deleteCategory(id: string) {
    const existing = await this.prisma.blogCategory.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundException('Category not found');

    // Check if category has posts
    const postCount = await this.prisma.blogPost.count({
      where: { categoryId: id },
    });
    if (postCount > 0) {
      throw new BadRequestException(
        'Cannot delete category with existing blog posts',
      );
    }

    return this.prisma.blogCategory.delete({ where: { id } });
  }

  // Legacy/Compatibility methods (if needed by blog.controller.ts)
  async findAllPosts(
    query: { categoryId?: string; status?: BlogStatus },
    includeDrafts = false,
  ) {
    // Anonymous readers only ever see PUBLISHED posts; the blog CMS
    // authenticates as ADMIN and keeps full visibility.
    const status = includeDrafts ? query.status : BlogStatus.PUBLISHED;
    return this.prisma.blogPost.findMany({
      where: {
        ...(query.categoryId && { categoryId: query.categoryId }),
        ...(status && { status }),
      },
      include: POST_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOnePost(idOrSlug: string, includeDrafts = false) {
    return this.prisma.blogPost.findFirst({
      where: {
        OR: [{ id: idOrSlug }, { slug: idOrSlug }],
        ...(!includeDrafts && { status: BlogStatus.PUBLISHED }),
      },
      include: POST_INCLUDE,
    });
  }

  async findAllCategories() {
    return this.getAllCategories();
  }

  async findAllAuthors() {
    return this.getAllAuthors();
  }

  async removePost(id: string) {
    return this.deletePost(id);
  }
}
