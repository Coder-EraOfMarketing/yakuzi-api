import { BlogService } from './blog.service';

/**
 * The admin list and the delete rule have to agree about what a post is.
 *
 * `deleteCategory` refuses on ANY post, drafts included. The category list
 * counted only published ones, so a category holding three drafts reported
 * "0 posts", the admin panel offered a delete button for it, and the API then
 * rejected the delete it had just invited.
 */
function buildService() {
  const findMany = jest.fn().mockResolvedValue([]);
  const service = new BlogService({ blogCategory: { findMany } } as never);
  return { service, findMany };
}

const postsSelect = (findMany: jest.Mock) =>
  findMany.mock.calls[0][0].include._count.select.posts;

describe('BlogService.getAllCategories', () => {
  it('counts published posts only by default — the storefront contract', () => {
    const { service, findMany } = buildService();

    void service.getAllCategories();

    expect(postsSelect(findMany)).toEqual({ where: { status: 'PUBLISHED' } });
  });

  it('counts drafts too when asked, which is what the admin needs', () => {
    const { service, findMany } = buildService();

    void service.getAllCategories(true);

    // `true` is Prisma's "all of them"; a where clause here would re-introduce
    // the mismatch with deleteCategory.
    expect(postsSelect(findMany)).toBe(true);
  });
});
