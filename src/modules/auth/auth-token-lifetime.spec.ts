import { Role } from '@prisma/client';
import { AuthService } from './auth.service';

/**
 * Access-token lifetime per role.
 *
 * Load-bearing, not cosmetic: apps/seller and apps/admin both ship a 401
 * interceptor that calls clearTokens() + logout() and hard-redirects to
 * /auth, with NO refresh attempt. Whatever this returns is therefore exactly
 * how long a seller or admin can work before being silently bounced to a
 * blank login page. Shortening either value without first adding a refresh
 * loop re-breaks seller login.
 */
const buildService = (env: Record<string, string> = {}) => {
  const signAsync = jest.fn().mockResolvedValue('signed-token');
  const configService = {
    get: jest.fn((key: string, fallback?: string) =>
      key in env ? env[key] : fallback,
    ),
  };
  const service = new AuthService(
    {} as never, // prisma
    { signAsync } as never, // jwtService
    configService as never,
    {} as never, // redis
    {} as never, // otpSmsService
    {} as never, // mailService
    {} as never, // buyerEmails
  );
  return { service, signAsync };
};

const accessExpiryFor = async (
  role: Role,
  env: Record<string, string> = {},
): Promise<string> => {
  const { service, signAsync } = buildService(env);
  await (
    service as never as {
      generateTokens(userId: string, role: Role): Promise<unknown>;
    }
  ).generateTokens('user-1', role);
  // First signAsync call is the ACCESS token, second is the refresh token.
  return (signAsync.mock.calls[0][1] as { expiresIn: string }).expiresIn;
};

describe('AuthService.generateTokens — access token lifetime by role', () => {
  it('gives SELLER a full working session, not 15 minutes', async () => {
    // The regression this file exists for: sellers inherited the 15m default
    // while having no refresh loop, so every seller was logged out mid-session.
    expect(await accessExpiryFor(Role.SELLER)).toBe('8h');
  });

  it('leaves ADMIN unchanged', async () => {
    expect(await accessExpiryFor(Role.ADMIN)).toBe('8h');
  });

  it('leaves BUYER on the short token — the buyer app refreshes', async () => {
    expect(await accessExpiryFor(Role.BUYER)).toBe('15m');
  });

  it('honours JWT_SELLER_ACCESS_EXPIRES when set', async () => {
    expect(
      await accessExpiryFor(Role.SELLER, { JWT_SELLER_ACCESS_EXPIRES: '12h' }),
    ).toBe('12h');
  });

  it('does not let the buyer override change the seller lifetime', async () => {
    // JWT_ACCESS_EXPIRES is the buyer/default knob. A seller must not pick it
    // up, or tightening buyer tokens would silently log sellers out again.
    expect(
      await accessExpiryFor(Role.SELLER, { JWT_ACCESS_EXPIRES: '15m' }),
    ).toBe('8h');
  });

  it('keeps the refresh token on the shared 7d default for every role', async () => {
    for (const role of [Role.SELLER, Role.ADMIN, Role.BUYER]) {
      const { service, signAsync } = buildService();
      await (
        service as never as {
          generateTokens(userId: string, role: Role): Promise<unknown>;
        }
      ).generateTokens('user-1', role);
      expect((signAsync.mock.calls[1][1] as { expiresIn: string }).expiresIn).toBe('7d');
    }
  });
});
