import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { BlogService } from './blog.service';

/**
 * Creating a category that already exists put Prisma's own error in front of
 * an admin — the deployed source path, the lines around the call, and
 * "Unique constraint failed on the fields: (`name`)" — which says nothing
 * about what to do next. Both `name` and `slug` are unique and they fail for
 * different reasons, so the message has to name the one that collided.
 */
function uniqueViolation(target: string[]): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target },
  });
}

function buildService(createError: unknown) {
  const prisma = {
    blogCategory: {
      create: jest.fn().mockRejectedValue(createError),
      findUnique: jest.fn().mockResolvedValue({ id: 'c1', name: 'Social', slug: 'social' }),
      update: jest.fn().mockRejectedValue(createError),
    },
  };
  return new BlogService(prisma as never);
}

describe('BlogService category name collisions', () => {
  it('names the category when the name is taken', async () => {
    const service = buildService(uniqueViolation(['name']));

    await expect(service.createCategory({ name: 'Social' } as never)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('"Social"'),
    });
  });

  it('points at the URL when only the slug collides', async () => {
    // "Anime News" and "Anime news" are different names that slug the same —
    // "rename it" and "it already exists" are different instructions.
    const service = buildService(uniqueViolation(['slug']));

    const error = await service
      .createCategory({ name: 'Anime news' } as never)
      .catch((e) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect(error.message).toContain('anime-news');
  });

  it('never leaks the Prisma invocation text', async () => {
    const service = buildService(uniqueViolation(['name']));

    const error = await service.createCategory({ name: 'Social' } as never).catch((e) => e);

    expect(error.message).not.toContain('prisma');
    expect(error.message).not.toContain('blog.service.ts');
  });

  it('lets an unrelated failure through untouched', async () => {
    // Only the duplicate case is translated; a connection failure must still
    // surface as the 500 it is, not as a misleading 409.
    const boom = new Error('connection terminated unexpectedly');
    const service = buildService(boom);

    await expect(service.createCategory({ name: 'Social' } as never)).rejects.toBe(boom);
  });

  it('applies the same translation when renaming a category', async () => {
    const service = buildService(uniqueViolation(['name']));

    await expect(
      service.updateCategory('c1', { name: 'Cultural' } as never),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
