import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { AdminAccessGuard } from './admin-access.guard';
import {
  grantsAllow,
  grantsFromInput,
  hasAnyWriteAccess,
  parseAdminGrants,
  serializeAdminGrants,
} from './admin-grants';
import { resolveAdminRoute, normalizeAdminPath } from './admin-route-map';

describe('admin grants storage format', () => {
  it('reads every legacy value as Super Admin so existing admins keep their access', () => {
    // The whole back-compatibility promise lives in these four cases.
    expect(parseAdminGrants('').isSuper).toBe(true);
    expect(parseAdminGrants(null).isSuper).toBe(true);
    expect(parseAdminGrants(undefined).isSuper).toBe(true);
    expect(parseAdminGrants('1357x').isSuper).toBe(true);
  });

  it('round-trips a restricted grant', () => {
    const stored = serializeAdminGrants({
      isSuper: false,
      tabs: { orders: 'partial', tickets: 'full' },
    });
    expect(stored).toBe('v2:{"orders":"partial","tickets":"full"}');

    const parsed = parseAdminGrants(stored);
    expect(parsed.isSuper).toBe(false);
    expect(parsed.tabs).toEqual({ orders: 'partial', tickets: 'full' });
  });

  it('serializes super admin compactly', () => {
    expect(serializeAdminGrants({ isSuper: true, tabs: {} })).toBe('v2:super');
    expect(parseAdminGrants('v2:super').isSuper).toBe(true);
  });

  it('drops none levels and unknown tabs instead of storing them', () => {
    const stored = serializeAdminGrants({
      isSuper: false,
      tabs: { orders: 'none', products: 'view' } as any,
    });
    expect(stored).toBe('v2:{"products":"view"}');
    expect(parseAdminGrants('v2:{"nosuchtab":"full","orders":"view"}').tabs).toEqual({
      orders: 'view',
    });
  });

  it('fails closed on an unreadable v2 payload rather than granting everything', () => {
    const parsed = parseAdminGrants('v2:{not json');
    expect(parsed.isSuper).toBe(false);
    expect(parsed.tabs).toEqual({});
  });

  it('compares levels as a ladder', () => {
    const grants = parseAdminGrants('v2:{"orders":"partial"}');
    expect(grantsAllow(grants, 'orders', 'view')).toBe(true);
    expect(grantsAllow(grants, 'orders', 'partial')).toBe(true);
    expect(grantsAllow(grants, 'orders', 'full')).toBe(false);
    expect(grantsAllow(grants, 'products', 'view')).toBe(false);
  });

  it('rejects bad input from the grant screen instead of silently narrowing it', () => {
    expect(grantsFromInput({ tabs: { orders: 'partial' } }).errors).toEqual([]);
    expect(grantsFromInput({ tabs: { orders: 'sometimes' } }).errors).toHaveLength(1);
    expect(grantsFromInput({ tabs: { nope: 'full' } }).errors).toHaveLength(1);
    expect(grantsFromInput({ isSuper: true }).grants.isSuper).toBe(true);
  });

  it('knows whether an admin can write anywhere at all', () => {
    expect(hasAnyWriteAccess(parseAdminGrants('v2:{"orders":"view"}'))).toBe(false);
    expect(hasAnyWriteAccess(parseAdminGrants('v2:{"orders":"partial"}'))).toBe(true);
    expect(hasAnyWriteAccess(parseAdminGrants('v2:super'))).toBe(true);
  });
});

describe('admin route map', () => {
  it('strips the global prefix, the query string and trailing slashes', () => {
    expect(normalizeAdminPath('/api/admin/orders?page=2')).toBe('/admin/orders');
    expect(normalizeAdminPath('/admin/orders/')).toBe('/admin/orders');
  });

  it('treats reads as view and ordinary writes as partial', () => {
    expect(resolveAdminRoute('GET', '/api/admin/orders')).toEqual({
      kind: 'tab',
      tab: 'orders',
      required: 'view',
    });
    expect(resolveAdminRoute('PATCH', '/api/admin/orders/abc/status')).toEqual({
      kind: 'tab',
      tab: 'orders',
      required: 'partial',
    });
  });

  it('demands full edit for the risky actions in each group', () => {
    const full = (method: string, url: string) =>
      expect(resolveAdminRoute(method, url)).toMatchObject({ required: 'full' });

    full('PATCH', '/api/orders/abc/cancel');
    full('PATCH', '/api/admin/payments/abc/confirm');
    full('PATCH', '/api/admin/settlements/abc/mark-paid');
    full('PATCH', '/api/admin/users/abc/block');
    full('DELETE', '/api/admin/users/abc');
    full('PATCH', '/api/admin/products/abc/approve');
    full('DELETE', '/api/admin/products/abc');
    full('PATCH', '/api/admin/blogs/abc/status');
    full('POST', '/api/admin/notifications/broadcast');
    full('POST', '/api/admin/seo/redirects');
    full('DELETE', '/api/reviews/admin/abc');
    full('POST', '/api/admin/categories/bulk');
  });

  it('keeps editing metadata below the redirect bar on the SEO tab', () => {
    expect(resolveAdminRoute('PUT', '/api/admin/seo/meta')).toEqual({
      kind: 'tab',
      tab: 'seo',
      required: 'partial',
    });
  });

  it('separates Self Ship from the rest of the seller actions', () => {
    expect(resolveAdminRoute('PATCH', '/api/admin/sellers/abc/self-ship')).toMatchObject({
      tab: 'selfShip',
    });
    expect(resolveAdminRoute('PATCH', '/api/admin/sellers/abc/gst-pan-status')).toMatchObject({
      tab: 'users',
    });
  });

  it('leaves the dashboard and its analytics open to every admin', () => {
    expect(resolveAdminRoute('GET', '/api/admin/dashboard')).toEqual({ kind: 'allow' });
    expect(resolveAdminRoute('GET', '/api/admin/analytics/revenue')).toEqual({ kind: 'allow' });
  });

  it('reserves admin management and data migration for super admins', () => {
    expect(resolveAdminRoute('GET', '/api/admin/admins')).toEqual({ kind: 'super' });
    expect(resolveAdminRoute('POST', '/api/migration/import/users')).toEqual({ kind: 'super' });
  });

  it('gates uploads on being able to write somewhere, not on one tab', () => {
    expect(resolveAdminRoute('POST', '/api/storage/upload')).toEqual({ kind: 'anyWrite' });
  });

  it('denies routes it has never heard of', () => {
    expect(resolveAdminRoute('POST', '/api/admin/some-new-thing')).toEqual({ kind: 'deny' });
  });
});

describe('AdminAccessGuard', () => {
  const context = (
    user: unknown,
    method: string,
    url: string,
    roles: Role[] | undefined = [Role.ADMIN],
  ) => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(roles),
    } as unknown as Reflector;
    const ctx = {
      switchToHttp: () => ({ getRequest: () => ({ user, method, originalUrl: url }) }),
      getHandler: () => undefined,
      getClass: () => undefined,
    } as unknown as ExecutionContext;
    return { reflector, ctx };
  };

  const prisma = {
    adminProfile: { findUnique: jest.fn() },
  } as any;

  const admin = (permissions: string | null) => ({
    id: 'admin-1',
    role: Role.ADMIN,
    adminProfile: permissions === null ? null : { permissions },
  });

  it('ignores buyers, sellers and anonymous traffic', async () => {
    const { reflector, ctx } = context({ id: 'b1', role: Role.BUYER }, 'GET', '/api/orders/1');
    await expect(new AdminAccessGuard(reflector, prisma).canActivate(ctx)).resolves.toBe(true);

    const anon = context(undefined, 'GET', '/api/products');
    await expect(
      new AdminAccessGuard(anon.reflector, prisma).canActivate(anon.ctx),
    ).resolves.toBe(true);
  });

  it('ignores routes that are not admin-only, so shared pickers keep working', async () => {
    const { reflector, ctx } = context(
      admin('v2:{}'),
      'GET',
      '/api/products',
      [Role.BUYER, Role.SELLER],
    );
    await expect(new AdminAccessGuard(reflector, prisma).canActivate(ctx)).resolves.toBe(true);
  });

  it('lets every pre-existing admin through untouched', async () => {
    for (const legacy of ['', '1357x', 'x']) {
      const { reflector, ctx } = context(admin(legacy), 'DELETE', '/api/admin/products/p1');
      await expect(new AdminAccessGuard(reflector, prisma).canActivate(ctx)).resolves.toBe(true);
    }
  });

  it('allows a partial-edit admin the everyday action and refuses the risky one', async () => {
    const grants = 'v2:{"orders":"partial"}';

    const ok = context(admin(grants), 'PATCH', '/api/admin/orders/o1/status');
    await expect(new AdminAccessGuard(ok.reflector, prisma).canActivate(ok.ctx)).resolves.toBe(
      true,
    );

    const denied = context(admin(grants), 'PATCH', '/api/orders/o1/cancel');
    await expect(
      new AdminAccessGuard(denied.reflector, prisma).canActivate(denied.ctx),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses a tab the admin has no grant for', async () => {
    const { reflector, ctx } = context(admin('v2:{"orders":"full"}'), 'GET', '/api/admin/settlements');
    await expect(
      new AdminAccessGuard(reflector, prisma).canActivate(ctx),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses admin management to a non-super admin', async () => {
    const { reflector, ctx } = context(admin('v2:{"admins":"full"}'), 'GET', '/api/admin/admins');
    await expect(
      new AdminAccessGuard(reflector, prisma).canActivate(ctx),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('blocks uploads for a read-only admin but allows them for an editor', async () => {
    const reader = context(admin('v2:{"blogs":"view"}'), 'POST', '/api/storage/upload');
    await expect(
      new AdminAccessGuard(reader.reflector, prisma).canActivate(reader.ctx),
    ).rejects.toBeInstanceOf(ForbiddenException);

    const editor = context(admin('v2:{"blogs":"partial"}'), 'POST', '/api/storage/upload');
    await expect(
      new AdminAccessGuard(editor.reflector, prisma).canActivate(editor.ctx),
    ).resolves.toBe(true);
  });

  it('falls back to a query when the request user has no profile loaded', async () => {
    prisma.adminProfile.findUnique.mockResolvedValue({ permissions: 'v2:{"tickets":"view"}' });
    const { reflector, ctx } = context(
      { id: 'admin-2', role: Role.ADMIN },
      'GET',
      '/api/admin/tickets',
    );
    await expect(new AdminAccessGuard(reflector, prisma).canActivate(ctx)).resolves.toBe(true);
    expect(prisma.adminProfile.findUnique).toHaveBeenCalledWith({
      where: { userId: 'admin-2' },
      select: { permissions: true },
    });
  });
});
