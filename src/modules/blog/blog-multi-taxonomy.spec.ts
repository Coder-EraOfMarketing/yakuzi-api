import { BlogService, orderedIds } from './blog.service';

/**
 * Co-authors and additional categories, with BlogPost.authorId /
 * BlogPost.categoryId still the primary of each.
 *
 * Keeping the scalar columns is the whole safety of this change: the
 * storefront byline, the author pages, articleSection in the Article schema
 * and the chatbot's blog search all read them and none of them know these
 * tables exist. They must always hold the FIRST id of the list, and the list
 * must always contain the primary — otherwise the two disagree and which one
 * a given reader believes becomes a coin toss.
 */
describe('orderedIds', () => {
  it('puts the primary first and keeps the caller order after it', () => {
    expect(orderedIds(['b', 'c'], 'a')).toEqual(['a', 'b', 'c']);
  });

  it('does not duplicate a primary that is also in the list', () => {
    expect(orderedIds(['a', 'b'], 'a')).toEqual(['a', 'b']);
  });

  it('promotes the first of the list when there is no primary', () => {
    expect(orderedIds(['b', 'c'], null)).toEqual(['b', 'c']);
  });

  it('drops blanks and repeats rather than writing a broken join row', () => {
    expect(orderedIds(['b', '', ' ', 'b'], ' a ')).toEqual(['a', 'b']);
  });

  it('is empty when there is nothing — a post may have no category', () => {
    expect(orderedIds(undefined, null)).toEqual([]);
    expect(orderedIds([], undefined)).toEqual([]);
  });
});

function buildService(existing?: Record<string, unknown>) {
  const create = jest.fn().mockResolvedValue({ id: 'p1' });
  const update = jest.fn().mockResolvedValue({ id: 'p1' });
  const prisma = {
    blogPost: {
      create,
      update,
      findUnique: jest.fn().mockImplementation(({ where }: any) =>
        Promise.resolve(where.slug ? null : existing ?? null),
      ),
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };
  return { service: new BlogService(prisma as never), create, update };
}

const BASE = {
  title: 'Why fans collect',
  content: '<p>Text</p>',
  authorId: 'author-1',
  categoryId: 'cat-1',
} as never;

describe('BlogService.createPost with several authors and categories', () => {
  it('writes a join row per author, in byline order', async () => {
    const { service, create } = buildService();

    await service.createPost({ ...(BASE as object), authorIds: ['author-2'] } as never);

    expect(create.mock.calls[0][0].data.authors.create).toEqual([
      { authorId: 'author-1', position: 0 },
      { authorId: 'author-2', position: 1 },
    ]);
  });

  it('leaves the scalar author as the first of the list', async () => {
    const { service, create } = buildService();

    await service.createPost({
      ...(BASE as object),
      authorIds: ['author-1', 'author-2'],
    } as never);

    expect(create.mock.calls[0][0].data.author).toEqual({
      connect: { id: 'author-1' },
    });
  });

  it('files the post under every category it was given', async () => {
    const { service, create } = buildService();

    await service.createPost({
      ...(BASE as object),
      categoryIds: ['cat-2', 'cat-3'],
    } as never);

    expect(create.mock.calls[0][0].data.categories.create).toEqual([
      { categoryId: 'cat-1', position: 0 },
      { categoryId: 'cat-2', position: 1 },
      { categoryId: 'cat-3', position: 2 },
    ]);
    // The primary is still exactly one category.
    expect(create.mock.calls[0][0].data.category).toEqual({
      connect: { id: 'cat-1' },
    });
  });

  it('still works for a caller that sends no lists at all', async () => {
    const { service, create } = buildService();

    await service.createPost(BASE);

    expect(create.mock.calls[0][0].data.authors.create).toEqual([
      { authorId: 'author-1', position: 0 },
    ]);
  });
});

describe('BlogService.updatePost with several authors and categories', () => {
  const EXISTING = {
    id: 'p1',
    slug: 'why-fans-collect',
    authorId: 'author-1',
    categoryId: 'cat-1',
    status: 'DRAFT',
    publishedAt: null,
  };

  it('replaces the set rather than appending to it', async () => {
    // The list sent IS the list. Folding the existing primary back in would
    // make removing an author impossible, and the editor sends the full set.
    const { service, update } = buildService(EXISTING);

    await service.updatePost('p1', { authorIds: ['author-2'] } as never);

    const data = update.mock.calls[0][0].data;
    expect(data.authors.deleteMany).toEqual({});
    expect(data.authors.create).toEqual([{ authorId: 'author-2', position: 0 }]);
    expect(data.authorId).toBe('author-2');
  });

  it('refuses to leave a post with no author at all', async () => {
    // authorId is NOT NULL and the byline has to name someone; an empty list
    // would blank the join rows while the column still pointed somewhere.
    const { service } = buildService(EXISTING);

    await expect(
      service.updatePost('p1', { authorIds: [] } as never),
    ).rejects.toThrow(/at least one author/);
  });

  it('leaves the sets alone when the update does not mention them', async () => {
    // Renaming a post must not silently strip its co-authors.
    const { service, update } = buildService(EXISTING);

    await service.updatePost('p1', { title: 'New title' } as never);

    const data = update.mock.calls[0][0].data;
    expect(data.authors).toBeUndefined();
    expect(data.categories).toBeUndefined();
  });

  it('never sends the id lists as columns', async () => {
    const { service, update } = buildService(EXISTING);

    await service.updatePost('p1', {
      authorIds: ['author-2'],
      categoryIds: ['cat-2'],
    } as never);

    const data = update.mock.calls[0][0].data;
    expect(data.authorIds).toBeUndefined();
    expect(data.categoryIds).toBeUndefined();
  });

  it('moves the primary when the first of the list changes', async () => {
    const { service, update } = buildService(EXISTING);

    await service.updatePost('p1', {
      authorId: 'author-9',
      authorIds: ['author-9', 'author-1'],
      categoryIds: ['cat-5'],
    } as never);

    const data = update.mock.calls[0][0].data;
    expect(data.authorId).toBe('author-9');
    expect(data.categoryId).toBe('cat-5');
  });

  it('clears the category when the list is emptied', async () => {
    // Nullable column, and the storefront treats it as unfiled — but it must
    // not keep pointing at a category the post is no longer in.
    const { service, update } = buildService(EXISTING);

    await service.updatePost('p1', { categoryId: null, categoryIds: [] } as never);

    expect(update.mock.calls[0][0].data.categoryId).toBeNull();
    expect(update.mock.calls[0][0].data.categories.create).toEqual([]);
  });
});
