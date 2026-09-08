import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { AdminGrants, grantsAllow, hasAnyWriteAccess, parseAdminGrants } from './admin-grants';
import { resolveAdminRoute } from './admin-route-map';

/**
 * Enforces per-tab admin access on top of RolesGuard.
 *
 * RolesGuard answers "is this an admin at all"; this answers "is this admin
 * allowed to do THIS, on THIS tab". It runs after RolesGuard and only ever
 * restricts admins:
 *
 *  - not authenticated, or not an ADMIN -> untouched (other guards' business)
 *  - route is not admin-only (a shared or public endpoint) -> untouched, so
 *    the product/category pickers used across the panel keep working
 *  - admin is Super Admin (which every pre-existing admin reads as) -> allowed
 *
 * Only admins created or edited under the new grant screen can be refused.
 */
@Injectable()
export class AdminAccessGuard implements CanActivate {
  private readonly logger = new Logger(AdminAccessGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request?.user;

    if (!user || user.role !== Role.ADMIN) return true;

    // Only endpoints that actually demand the ADMIN role are gated. A route
    // that buyers or sellers may also call is not an admin-panel feature, and
    // an admin browsing it should not need a tab grant.
    const requiredRoles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!requiredRoles?.includes(Role.ADMIN)) return true;

    const grants = await this.resolveGrants(user);
    if (grants.isSuper) return true;

    const requirement = resolveAdminRoute(
      request.method,
      request.originalUrl ?? request.url ?? '',
    );

    switch (requirement.kind) {
      case 'allow':
        return true;

      case 'anyWrite':
        if (hasAnyWriteAccess(grants)) return true;
        throw new ForbiddenException(
          'Your access level is read-only, so you cannot upload files.',
        );

      case 'super':
        throw new ForbiddenException('Only a Super Admin can do this.');

      case 'tab':
        if (grantsAllow(grants, requirement.tab, requirement.required)) return true;
        throw new ForbiddenException(
          requirement.required === 'view'
            ? 'You do not have access to this section.'
            : `Your access to this section is limited, so you cannot perform this action.`,
        );

      case 'deny':
      default:
        this.logger.warn(
          `Denied ${request.method} ${request.originalUrl ?? request.url} for restricted admin ${user.id}: no tab mapping for this route`,
        );
        throw new ForbiddenException('You do not have access to this action.');
    }
  }

  /**
   * The JWT strategy loads the admin profile alongside the user, so this is
   * normally free. The query is a fallback for any auth path that populates
   * request.user without it - missing grants must not silently read as an
   * empty (deny-everything) profile.
   */
  private async resolveGrants(user: {
    id: string;
    adminProfile?: { permissions?: string | null } | null;
  }): Promise<AdminGrants> {
    if (user.adminProfile !== undefined) {
      return parseAdminGrants(user.adminProfile?.permissions);
    }

    const profile = await this.prisma.adminProfile.findUnique({
      where: { userId: user.id },
      select: { permissions: true },
    });
    return parseAdminGrants(profile?.permissions);
  }
}
