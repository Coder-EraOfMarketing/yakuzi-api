import { Role, UserStatus } from '@prisma/client';
import axios from 'axios';
import { AuthService } from './auth.service';
import * as social from './social-token.util';

/**
 * Google, Apple and Facebook all end in the same account rules. These tests pin
 * those rules once, through each provider's real entry point, and prove the
 * Google path behaves exactly as it did before the shared method was extracted.
 */
const build = (env: Record<string, string> = {}, existing: any = null) => {
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue(existing),
      create: jest.fn().mockImplementation(async ({ data }) => ({
        id: 'u-new', phone: null, ...data,
      })),
    },
    buyerProfile: {
      findUnique: jest.fn().mockResolvedValue({ id: 'bp' }),
      create: jest.fn().mockResolvedValue({}),
    },
  };
  const configService = { get: jest.fn((k: string) => env[k]) };
  const service = new AuthService(
    prisma as never,
    {} as never,
    configService as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  jest.spyOn(service as any, 'generateTokens').mockResolvedValue({ accessToken: 'a', refreshToken: 'r' });
  const welcome = jest.spyOn(service as any, 'welcomeIfNew').mockReturnValue(undefined);
  return { service, prisma, welcome };
};

const buyer = (over: Record<string, unknown> = {}) => ({
  id: 'u-1', email: 'fan@example.com', phone: '9000000000',
  role: Role.BUYER, status: UserStatus.APPROVED, ...over,
});

afterEach(() => jest.restoreAllMocks());

describe.each([
  {
    name: 'Apple',
    env: { APPLE_CLIENT_ID: 'com.yukizi.web' },
    mockVerify: (v: any) => jest.spyOn(social, 'verifyAppleIdentityToken').mockImplementation(v),
    call: (s: AuthService) => s.loginWithApple('tok'),
  },
  {
    name: 'Facebook',
    env: { FACEBOOK_APP_ID: '123', FACEBOOK_APP_SECRET: 'shh' },
    mockVerify: (v: any) => jest.spyOn(social, 'verifyFacebookAccessToken').mockImplementation(v),
    call: (s: AuthService) => s.loginWithFacebook('tok'),
  },
])('$name sign-in', ({ name, env, mockVerify, call }) => {
  const identity = { providerUserId: 'p-1', email: 'fan@example.com', displayName: 'Hinata Fan' };

  it('is inert (503) until configured, and never calls the provider', async () => {
    const { service } = build({});
    const spy = mockVerify(async () => identity);
    await expect(call(service)).rejects.toThrow(`${name} sign-in is not available right now`);
    expect(spy).not.toHaveBeenCalled();
  });

  it('turns every verification failure into one generic 401 that leaks nothing', async () => {
    const { service, prisma } = build(env);
    mockVerify(async () => { throw new social.SocialTokenError('wrong audience: com.other'); });
    const err: any = await call(service).catch((e) => e);
    expect(err.getStatus()).toBe(401);
    expect(err.message).toBe(`${name} sign-in failed. Please try again.`);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('creates an approved buyer with a profile for a new email', async () => {
    const { service, prisma, welcome } = build(env, null);
    mockVerify(async () => identity);
    const res = await call(service);
    expect(prisma.user.create).toHaveBeenCalledWith({
      data: { email: 'fan@example.com', role: Role.BUYER, status: UserStatus.APPROVED },
    });
    expect(prisma.buyerProfile.create).toHaveBeenCalledWith({
      data: { userId: 'u-new', legalName: 'Hinata Fan' },
    });
    expect(res.isNewUser).toBe(true);
    expect(res.accessToken).toBe('a');
    expect(welcome).toHaveBeenCalledWith('u-new', Role.BUYER, true);
  });

  it('signs an existing buyer in rather than duplicating the account', async () => {
    const { service, prisma } = build(env, buyer());
    mockVerify(async () => identity);
    const res = await call(service);
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(res.isNewUser).toBe(false);
    expect(res.user.id).toBe('u-1');
  });

  it('refuses a staff account: sellers and admins must use their password', async () => {
    for (const role of [Role.SELLER, Role.ADMIN]) {
      const { service } = build(env, buyer({ role }));
      mockVerify(async () => identity);
      await expect(call(service)).rejects.toThrow('registered to a staff account');
    }
  });

  it('refuses a blocked buyer', async () => {
    const { service } = build(env, buyer({ status: UserStatus.BLOCKED }));
    mockVerify(async () => identity);
    await expect(call(service)).rejects.toThrow('has been blocked');
  });

  it('backfills a missing profile on an existing account', async () => {
    const { service, prisma } = build(env, buyer());
    prisma.buyerProfile.findUnique.mockResolvedValue(null);
    mockVerify(async () => identity);
    await call(service);
    expect(prisma.buyerProfile.create).toHaveBeenCalledWith({
      data: { userId: 'u-1', legalName: 'Hinata Fan' },
    });
  });
});

describe('Facebook needs BOTH the app id and the secret', () => {
  it('is inert with only the app id set', async () => {
    const { service } = build({ FACEBOOK_APP_ID: '123' });
    await expect(service.loginWithFacebook('tok')).rejects.toThrow('not available right now');
  });
});

describe('Google sign-in is unchanged by the shared extraction', () => {
  const tokeninfo = (over: Record<string, unknown> = {}) => ({
    data: {
      aud: 'g-client', iss: 'https://accounts.google.com',
      exp: String(Math.floor(Date.now() / 1000) + 600),
      email: ' Fan@Example.com ', email_verified: 'true', name: ' Hinata Fan ',
      ...over,
    },
  });

  it('still creates a buyer from verified claims, trimming and lower-casing', async () => {
    const { service, prisma } = build({ GOOGLE_CLIENT_ID: 'g-client' }, null);
    jest.spyOn(axios, 'get').mockResolvedValue(tokeninfo());
    const res = await service.loginWithGoogle('tok');
    expect(prisma.user.create).toHaveBeenCalledWith({
      data: { email: 'fan@example.com', role: Role.BUYER, status: UserStatus.APPROVED },
    });
    expect(prisma.buyerProfile.create).toHaveBeenCalledWith({
      data: { userId: 'u-new', legalName: 'Hinata Fan' },
    });
    expect(res.isNewUser).toBe(true);
  });

  it('still rejects a token issued to a different client, an unverified email and a staff account', async () => {
    const a = build({ GOOGLE_CLIENT_ID: 'g-client' });
    jest.spyOn(axios, 'get').mockResolvedValue(tokeninfo({ aud: 'someone-else' }));
    await expect(a.service.loginWithGoogle('t')).rejects.toThrow('Google sign-in failed');

    const b = build({ GOOGLE_CLIENT_ID: 'g-client' });
    jest.spyOn(axios, 'get').mockResolvedValue(tokeninfo({ email_verified: 'false' }));
    await expect(b.service.loginWithGoogle('t')).rejects.toThrow('does not have a verified email');

    const c = build({ GOOGLE_CLIENT_ID: 'g-client' }, buyer({ role: Role.ADMIN }));
    jest.spyOn(axios, 'get').mockResolvedValue(tokeninfo());
    await expect(c.service.loginWithGoogle('t')).rejects.toThrow('registered to a staff account');
  });
});
