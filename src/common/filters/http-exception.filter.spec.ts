import { BadRequestException, ConflictException } from '@nestjs/common';
import { HttpExceptionFilter } from './http-exception.filter';

/**
 * An unhandled error's own message is written for whoever reads the logs, not
 * for whoever made the request. Prisma's renders as the deployed source path
 * plus the lines around the failing call, and that reached a browser.
 *
 * NODE_ENV is read once at module load, so each case loads the filter fresh.
 */
function buildHost() {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const response = { status, setHeader: jest.fn() };
  const request = { url: '/api/admin/blogs/categories', method: 'POST', headers: {} };
  return {
    host: {
      switchToHttp: () => ({
        getResponse: () => response,
        getRequest: () => request,
      }),
    } as never,
    body: () => json.mock.calls[0]?.[0],
    status: () => status.mock.calls[0]?.[0],
  };
}

/** The filter reads NODE_ENV per request, so this needs no module juggling —
 *  and juggling it would break `instanceof HttpException` anyway. */
function filterUnder(nodeEnv: string): HttpExceptionFilter {
  process.env.NODE_ENV = nodeEnv;
  return new HttpExceptionFilter();
}

const PRISMA_LEAK = new Error(
  'Invalid `this.prisma.blogCategory.create()` invocation in\n' +
    '/home/yukizi_deploy/yakuzi-api/src/modules/blog/blog.service.ts:494:37\n' +
    "491 .replace(/ /g, '-')\n" +
    'Unique constraint failed on the fields: (`name`)',
);

describe('HttpExceptionFilter', () => {
  const originalEnv = process.env.NODE_ENV;

  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it('does not send an unhandled error message to the client in production', () => {
    const ctx = buildHost();
    filterUnder('production').catch(PRISMA_LEAK, ctx.host);

    expect(ctx.status()).toBe(500);
    const body = ctx.body();
    expect(body.message).toBe('Something went wrong on our side. Please try again.');
    // The three things that must never leave the server.
    expect(JSON.stringify(body)).not.toContain('/home/yukizi_deploy');
    expect(JSON.stringify(body)).not.toContain('blog.service.ts');
    expect(JSON.stringify(body)).not.toContain('prisma');
  });

  it('still shows the detail outside production, where it is the point', () => {
    const ctx = buildHost();
    filterUnder('development').catch(PRISMA_LEAK, ctx.host);

    expect(ctx.body().message).toContain('Unique constraint failed');
  });

  it('never suppresses a deliberate HttpException message', () => {
    // These are written for the caller — "A category called X already
    // exists" is the whole reason the service throws one.
    const ctx = buildHost();
    filterUnder('production').catch(
      new ConflictException('A category called "Social" already exists.'),
      ctx.host,
    );

    expect(ctx.status()).toBe(409);
    expect(ctx.body().message).toBe('A category called "Social" already exists.');
  });

  it('keeps validation messages intact in production', () => {
    const ctx = buildHost();
    filterUnder('production').catch(
      new BadRequestException(['name should not be empty']),
      ctx.host,
    );

    expect(ctx.status()).toBe(400);
    expect(ctx.body().message).toEqual(['name should not be empty']);
  });
});
