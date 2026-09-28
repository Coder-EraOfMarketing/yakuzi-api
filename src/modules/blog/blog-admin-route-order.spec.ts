import 'reflect-metadata';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { BlogAdminController } from './blog-admin.controller';

/**
 * Nest matches routes in the order their handlers are declared, so a
 * single-segment `:id` pattern swallows every static sibling declared after it.
 *
 * `@Get(':id')` sat above `@Get('authors')` and `@Get('categories')`, so
 * `GET /admin/blogs/authors` matched the wildcard with id="authors",
 * ParseUUIDPipe rejected it, and the blog editor's author and category
 * dropdowns were empty from the day they shipped. Creating an author still
 * worked — POST has no such collision — and only the refetch failed, so it
 * read as "the button does nothing"; the same author was created four times
 * before anyone looked at the database.
 *
 * Asserting the specific ordering would only pin this one instance, so this
 * checks the rule: on a given HTTP method, no route whose first segment is a
 * parameter may be declared before a route with a literal first segment.
 */

interface Route {
  handler: string;
  method: number;
  path: string;
  index: number;
}

function routesOf(controller: new (...args: never[]) => unknown): Route[] {
  const proto = controller.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(proto)
    .filter((name) => name !== 'constructor' && typeof proto[name] === 'function')
    .map((handler, index) => {
      const fn = proto[handler] as object;
      const path = Reflect.getMetadata(PATH_METADATA, fn) as string | undefined;
      const method = Reflect.getMetadata(METHOD_METADATA, fn) as number | undefined;
      return path === undefined || method === undefined
        ? null
        : { handler, method, path: path.replace(/^\//, ''), index };
    })
    .filter((r): r is Route => r !== null);
}

const firstSegment = (path: string) => path.split('/')[0] ?? '';
const isWildcard = (path: string) => firstSegment(path).startsWith(':');

describe('BlogAdminController route order', () => {
  const routes = routesOf(BlogAdminController);

  it('declares handlers this test can actually read', () => {
    // A guard on the reflection above: if Nest ever changes its metadata keys
    // this spec would pass vacuously while the bug walks straight back in.
    expect(routes.length).toBeGreaterThan(10);
    expect(routes.some((r) => r.path === 'authors')).toBe(true);
    expect(routes.some((r) => r.path === ':id')).toBe(true);
  });

  it('never declares a wildcard segment before a static route on the same method', () => {
    const offences: string[] = [];

    for (const wildcard of routes.filter((r) => isWildcard(r.path))) {
      for (const literal of routes) {
        if (literal.method !== wildcard.method) continue;
        if (isWildcard(literal.path)) continue;
        if (literal.index < wildcard.index) continue;
        // Only a literal of the SAME shape is shadowed: ':id' hides 'authors',
        // but it cannot hide 'authors/:id' — that is two segments.
        if (literal.path.split('/').length !== wildcard.path.split('/').length) continue;
        offences.push(
          `${wildcard.handler} ('${wildcard.path}') is declared before ${literal.handler} ('${literal.path}'), which it will swallow`,
        );
      }
    }

    expect(offences).toEqual([]);
  });

  it('keeps the dropdown endpoints reachable', () => {
    // The two that were actually broken, named so a failure says what broke.
    for (const path of ['authors', 'categories']) {
      const literal = routes.find((r) => r.path === path && r.method === RequestMethod.GET);
      const wildcard = routes.find((r) => r.path === ':id' && r.method === RequestMethod.GET);
      expect(literal).toBeDefined();
      expect(wildcard).toBeDefined();
      expect(literal!.index).toBeLessThan(wildcard!.index);
    }
  });
});
