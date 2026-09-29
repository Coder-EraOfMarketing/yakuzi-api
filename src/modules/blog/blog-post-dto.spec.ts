import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { CreateBlogPostDto } from './dto/create-blog-post.dto';
import { UpdateBlogPostDto } from './dto/update-blog-post.dto';

/**
 * Run bodies through a pipe configured EXACTLY as main.ts configures the
 * global one. validateSync alone would not catch this class of bug: the fault
 * is not a failing constraint, it is a property carrying none at all.
 *
 * `whitelist` strips unconstrained properties and `forbidNonWhitelisted`
 * rejects them instead. `content` had only @ApiProperty — a Swagger
 * decorator, which registers no class-validator metadata — so every attempt
 * to CREATE a post was answered with "property content should not exist" and
 * no post could ever be written. The site had zero posts, an empty RSS feed
 * and an empty blog sitemap as a direct result.
 *
 * Updates were unaffected, which is why nothing else in the editor looked
 * broken: PartialType applies a real @IsOptional() to every property it
 * copies, so `content` was whitelisted there. Both paths are covered below
 * so neither can regress independently of the other.
 */
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
});

const run = (metatype: unknown, value: Record<string, unknown>) =>
  pipe.transform(value, { type: 'body', metatype: metatype as never });

const VALID = {
  title: 'Why Anime Has One of the Most Inclusive Fan Communities Today',
  content: '<h2>Introduction</h2><p>In a world where…</p>',
  authorId: '11111111-1111-4111-8111-111111111111',
  categoryId: '22222222-2222-4222-8222-222222222222',
};

describe('CreateBlogPostDto through the real global pipe', () => {
  it('accepts a post body and keeps its content', async () => {
    const dto = (await run(CreateBlogPostDto, VALID)) as CreateBlogPostDto;

    expect(dto.content).toBe(VALID.content);
    expect(dto.title).toBe(VALID.title);
  });

  it('still accepts the historical Editor.js object', async () => {
    const content = { blocks: [{ type: 'paragraph', data: { text: 'hi' } }] };

    const dto = (await run(CreateBlogPostDto, { ...VALID, content })) as CreateBlogPostDto;

    expect(dto.content).toEqual(content);
  });

  it('rejects a post with no content at all', async () => {
    const { content, ...withoutContent } = VALID;

    await expect(run(CreateBlogPostDto, withoutContent)).rejects.toThrow();
  });

  it('still rejects a property that genuinely does not belong', async () => {
    // The whitelist is doing its job; the bug was that `content` looked like
    // one of these to it. The detail lives on the response, not on .message.
    const error: any = await run(CreateBlogPostDto, { ...VALID, nonsense: 'x' }).catch(
      (e) => e,
    );

    expect(error.getStatus()).toBe(400);
    expect(JSON.stringify(error.getResponse())).toContain('nonsense');
  });

  it('accepts the author and category sets', async () => {
    const dto = (await run(CreateBlogPostDto, {
      ...VALID,
      authorIds: [VALID.authorId, '33333333-3333-4333-8333-333333333333'],
      categoryIds: [VALID.categoryId],
    })) as CreateBlogPostDto;

    expect(dto.authorIds).toHaveLength(2);
    expect(dto.categoryIds).toEqual([VALID.categoryId]);
  });
});

describe('UpdateBlogPostDto through the real global pipe', () => {
  it('accepts an update that carries content', async () => {
    // This path always worked — PartialType adds @IsOptional(), which is
    // real metadata — and it is pinned so it cannot start failing quietly.
    const dto = (await run(UpdateBlogPostDto, {
      content: '<p>Edited.</p>',
    })) as UpdateBlogPostDto;

    expect(dto.content).toBe('<p>Edited.</p>');
  });

  it('accepts an update that does not mention content', async () => {
    const dto = (await run(UpdateBlogPostDto, { title: 'New title' })) as UpdateBlogPostDto;

    expect(dto.title).toBe('New title');
    expect(dto.content).toBeUndefined();
  });
});
