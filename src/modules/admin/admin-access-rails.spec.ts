import { BadRequestException } from '@nestjs/common';
import { AdminService } from './admin.service';

/**
 * Covers the two things that can lock everyone out of the admin panel, plus
 * the write path that decides what a grant actually stores.
 */
describe('AdminService admin-access rails', () => {
  const makeService = (prisma: any) =>
    new AdminService(
      prisma,
      {} as any, // notifications
      {} as any, // orders
      {} as any, // sellers
      {} as any, // mail
      {} as any, // products
      {} as any, // config
    );

  const adminRow = (id: string, permissions: string | null) => ({
    id,
    role: 'ADMIN',
    phone: '9000000000',
    adminProfile: permissions === null ? null : { permissions },
  });

  describe('resolveGrantsForWrite', () => {
    const resolve = (dto: any) => (makeService({}) as any).resolveGrantsForWrite(dto);

    it('uses the structured grant the new screen sends', () => {
      expect(resolve({ access: { isSuper: false, tabs: { orders: 'partial' } } })).toEqual({
        isSuper: false,
        tabs: { orders: 'partial' },
      });
      expect(resolve({ access: { isSuper: true } }).isSuper).toBe(true);
    });

    it('rejects a malformed grant with a 400 rather than storing less than intended', () => {
      expect(() => resolve({ access: { tabs: { orders: 'kind-of' } } })).toThrow(
        BadRequestException,
      );
    });

    it('translates the old letter codes so the previous screen keeps working', () => {
      // 1 = View Users, 4 = Manage Products, b = View Tickets
      expect(resolve({ permissions: '14b' })).toEqual({
        isSuper: false,
        tabs: { users: 'view', products: 'full', tickets: 'view' },
      });
    });

    it('maps the old analytics codes onto the Dashboard tab', () => {
      // p = View Analytics, q = Manage Analytics - both gated the dashboard.
      expect(resolve({ permissions: 'p' }).tabs).toEqual({ dashboard: 'view' });
      expect(resolve({ permissions: 'q' }).tabs).toEqual({ dashboard: 'view' });
    });

    it('lets Manage win over View when both codes are present for one tab', () => {
      // 3 = View Products, 4 = Manage Products
      expect(resolve({ permissions: '34' }).tabs).toEqual({ products: 'full' });
      expect(resolve({ permissions: '43' }).tabs).toEqual({ products: 'full' });
    });

    it('keeps the old meaning of an empty permissions value: full access', () => {
      expect(resolve({}).isSuper).toBe(true);
      expect(resolve({ permissions: '' }).isSuper).toBe(true);
      expect(resolve({ permissions: 'x' }).isSuper).toBe(true);
    });
  });

  describe('updateAdmin', () => {
    it('refuses to let a super admin demote themselves', async () => {
      const prisma = {
        user: { findUnique: jest.fn().mockResolvedValue(adminRow('me', 'v2:super')) },
      };
      await expect(
        makeService(prisma).updateAdmin('me', 'me', {
          access: { isSuper: false, tabs: { orders: 'view' } },
        }),
      ).rejects.toThrow(/your own Super Admin access/i);
    });

    it('refuses to demote the last super admin', async () => {
      const prisma = {
        user: {
          findUnique: jest.fn().mockResolvedValue(adminRow('other', 'v2:super')),
          // Everyone else is restricted, so demoting this one leaves nobody.
          findMany: jest.fn().mockResolvedValue([{ adminProfile: { permissions: 'v2:{}' } }]),
        },
      };
      await expect(
        makeService(prisma).updateAdmin('me', 'other', { access: { isSuper: false, tabs: {} } }),
      ).rejects.toThrow(/last Super Admin/i);
    });

    it('allows the demotion when another super admin remains', async () => {
      const prisma = {
        user: {
          findUnique: jest.fn().mockResolvedValue(adminRow('other', 'v2:super')),
          findMany: jest.fn().mockResolvedValue([
            { adminProfile: { permissions: 'v2:super' } },
            { adminProfile: { permissions: 'v2:{}' } },
          ]),
        },
        adminProfile: {
          upsert: jest.fn().mockResolvedValue({
            userId: 'other',
            displayName: 'Other',
            department: '',
            permissions: 'v2:{"orders":"view"}',
            user: { id: 'other', phone: '9000000000', email: null, createdAt: new Date() },
          }),
        },
      };

      const result = await makeService(prisma).updateAdmin('me', 'other', {
        access: { isSuper: false, tabs: { orders: 'view' } },
      });

      expect(result.access).toEqual({ isSuper: false, tabs: { orders: 'view' } });
      expect(prisma.adminProfile.upsert).toHaveBeenCalled();
    });

    it('counts a legacy admin as a super admin when checking the last one', async () => {
      const prisma = {
        user: {
          findUnique: jest.fn().mockResolvedValue(adminRow('other', 'v2:super')),
          // Empty permissions = super admin under the legacy rule, so this
          // demotion is safe and must be allowed.
          findMany: jest.fn().mockResolvedValue([{ adminProfile: { permissions: '' } }]),
        },
        adminProfile: {
          upsert: jest.fn().mockResolvedValue({
            userId: 'other',
            displayName: 'Other',
            department: '',
            permissions: 'v2:{}',
            user: { id: 'other', phone: '9000000000', email: null, createdAt: new Date() },
          }),
        },
      };

      await expect(
        makeService(prisma).updateAdmin('me', 'other', { access: { isSuper: false, tabs: {} } }),
      ).resolves.toBeDefined();
    });

    it('leaves access untouched when the edit only renames the admin', async () => {
      const prisma = {
        user: { findUnique: jest.fn().mockResolvedValue(adminRow('other', 'v2:super')) },
        adminProfile: {
          upsert: jest.fn().mockResolvedValue({
            userId: 'other',
            displayName: 'New Name',
            department: '',
            permissions: 'v2:super',
            user: { id: 'other', phone: '9000000000', email: null, createdAt: new Date() },
          }),
        },
      };

      await makeService(prisma).updateAdmin('me', 'other', { name: 'New Name' });

      expect(prisma.adminProfile.upsert.mock.calls[0][0].update.permissions).toBeUndefined();
    });
  });

  describe('deleteAdmin', () => {
    it('refuses self-deletion', async () => {
      const prisma = {
        user: { findUnique: jest.fn().mockResolvedValue(adminRow('me', 'v2:super')) },
      };
      await expect(makeService(prisma).deleteAdmin('me', 'me')).rejects.toThrow(
        /your own admin account/i,
      );
    });

    it('refuses to delete the last super admin', async () => {
      const prisma = {
        user: {
          findUnique: jest.fn().mockResolvedValue(adminRow('other', 'v2:super')),
          findMany: jest.fn().mockResolvedValue([{ adminProfile: { permissions: 'v2:{}' } }]),
        },
      };
      await expect(makeService(prisma).deleteAdmin('me', 'other')).rejects.toThrow(
        /last Super Admin/i,
      );
    });

    it('deletes a restricted admin without consulting the super-admin count', async () => {
      const prisma = {
        user: {
          findUnique: jest.fn().mockResolvedValue(adminRow('other', 'v2:{"orders":"view"}')),
          findMany: jest.fn(),
          delete: jest.fn().mockResolvedValue({}),
        },
      };

      await expect(makeService(prisma).deleteAdmin('me', 'other')).resolves.toEqual({
        success: true,
        message: 'Admin deleted successfully',
      });
      expect(prisma.user.findMany).not.toHaveBeenCalled();
    });
  });
});
