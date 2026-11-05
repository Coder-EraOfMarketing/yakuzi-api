import * as crypto from 'crypto';
import {
  AppleJwks,
  HttpGet,
  JwksSource,
  SocialTokenError,
  verifyAppleIdentityToken,
  verifyFacebookAccessToken,
} from './social-token.util';

const CLIENT_ID = 'com.yukizi.web';
const NOW = Date.parse('2026-11-05T10:00:00Z');

const b64url = (o: object | Buffer) =>
  Buffer.from(Buffer.isBuffer(o) ? o : JSON.stringify(o)).toString('base64url');

// A real RSA key pair: the verifier does real signature maths, so the tests do too.
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };

const sign = (
  claims: Record<string, unknown>,
  over: { header?: Record<string, unknown>; key?: crypto.KeyObject } = {},
) => {
  const header = { alg: 'RS256', kid: 'k1', ...over.header };
  const input = `${b64url(header)}.${b64url(claims)}`;
  const sig = crypto.sign('RSA-SHA256', Buffer.from(input), over.key ?? privateKey);
  return `${input}.${b64url(sig)}`;
};

const goodClaims = {
  iss: 'https://appleid.apple.com',
  aud: CLIENT_ID,
  exp: Math.floor(NOW / 1000) + 600,
  sub: '001234.abcd',
  email: 'Fan@Example.com',
  email_verified: 'true',
};

const jwks: JwksSource = { getKeys: async () => [jwk] };
const verify = (token: string, source: JwksSource = jwks) =>
  verifyAppleIdentityToken(token, CLIENT_ID, source, NOW);

describe('verifyAppleIdentityToken', () => {
  it('accepts a correctly signed token and normalises the email', async () => {
    await expect(verify(sign(goodClaims))).resolves.toEqual({
      providerUserId: '001234.abcd',
      email: 'fan@example.com',
      displayName: '',
    });
  });

  it('accepts email_verified sent as a boolean', async () => {
    await expect(verify(sign({ ...goodClaims, email_verified: true }))).resolves.toBeDefined();
  });

  it('rejects a token signed by someone else', async () => {
    await expect(verify(sign(goodClaims, { key: other.privateKey }))).rejects.toThrow('bad signature');
  });

  it('rejects a tampered payload even though the old signature is intact', async () => {
    const [h, , s] = sign(goodClaims).split('.');
    const forged = `${h}.${b64url({ ...goodClaims, email: 'victim@example.com' })}.${s}`;
    await expect(verify(forged)).rejects.toThrow('bad signature');
  });

  it('refuses any algorithm other than RS256 (no alg:none / HS256 downgrade)', async () => {
    await expect(verify(sign(goodClaims, { header: { alg: 'none' } }))).rejects.toThrow('unexpected alg');
    await expect(verify(sign(goodClaims, { header: { alg: 'HS256' } }))).rejects.toThrow('unexpected alg');
  });

  it('rejects a valid Apple token issued to a different application', async () => {
    await expect(verify(sign({ ...goodClaims, aud: 'com.someone.else' }))).rejects.toThrow('wrong audience');
  });

  it('rejects the wrong issuer', async () => {
    await expect(verify(sign({ ...goodClaims, iss: 'https://evil.example' }))).rejects.toThrow('wrong issuer');
  });

  it('rejects an expired token', async () => {
    await expect(verify(sign({ ...goodClaims, exp: Math.floor(NOW / 1000) - 1 }))).rejects.toThrow('expired');
  });

  it('rejects an unverified email, a missing email and a missing subject', async () => {
    await expect(verify(sign({ ...goodClaims, email_verified: 'false' }))).rejects.toThrow('email not verified');
    await expect(verify(sign({ ...goodClaims, email: '' }))).rejects.toThrow('no email');
    await expect(verify(sign({ ...goodClaims, sub: undefined }))).rejects.toThrow('no subject');
  });

  it('rejects garbage and a token whose key id Apple does not publish', async () => {
    await expect(verify('not.a.jwt.at.all')).rejects.toThrow(SocialTokenError);
    await expect(verify('only.two')).rejects.toThrow('not a JWT');
    await expect(verify(sign(goodClaims, { header: { kid: 'unknown' } }))).rejects.toThrow('signing key not found');
  });

  it('refreshes Apple\'s keys once when the key id is new, then accepts', async () => {
    const jw = new AppleJwks();
    const calls: boolean[] = [];
    jest.spyOn(jw, 'getKeys').mockImplementation(async (force?: boolean) => {
      calls.push(!!force);
      return force ? [jwk] : [];
    });
    await expect(verify(sign(goodClaims), jw)).resolves.toBeDefined();
    expect(calls).toEqual([false, true]);
  });
});

describe('verifyFacebookAccessToken', () => {
  const APP_ID = '123456';
  const respond = (debug: unknown, me: unknown): HttpGet => ({
    get: async (url: string) => {
      if (url.endsWith('/debug_token')) {
        if (debug instanceof Error) throw debug;
        return { data: debug } as never;
      }
      if (me instanceof Error) throw me;
      return { data: me } as never;
    },
  });
  const okDebug = { data: { is_valid: true, app_id: APP_ID, user_id: '999', expires_at: 0 } };
  const okMe = { id: '999', name: ' Hinata Fan ', email: 'Fan@Example.com' };
  const run = (http: HttpGet) => verifyFacebookAccessToken('tok', APP_ID, 'secret', http, NOW);

  it('returns the verified identity', async () => {
    await expect(run(respond(okDebug, okMe))).resolves.toEqual({
      providerUserId: '999',
      email: 'fan@example.com',
      displayName: 'Hinata Fan',
    });
  });

  it('queries debug_token with the server-side app token, never the client secret in the user token', async () => {
    const seen: Array<{ url: string; params?: Record<string, string> }> = [];
    const http: HttpGet = {
      get: async (url: string, cfg) => {
        seen.push({ url, params: cfg?.params });
        return { data: url.endsWith('/debug_token') ? okDebug : okMe } as never;
      },
    };
    await run(http);
    expect(seen[0].params).toEqual({ input_token: 'tok', access_token: `${APP_ID}|secret` });
    expect(seen[1].params?.access_token).toBe('tok');
  });

  it('rejects a token Facebook says is invalid', async () => {
    await expect(run(respond({ data: { is_valid: false } }, okMe))).rejects.toThrow('token not valid');
  });

  it('rejects a valid token that was issued to a DIFFERENT app', async () => {
    await expect(run(respond({ data: { ...okDebug.data, app_id: '777' } }, okMe))).rejects.toThrow('wrong app');
  });

  it('rejects an expired token but accepts expires_at 0 (never expires)', async () => {
    await expect(
      run(respond({ data: { ...okDebug.data, expires_at: Math.floor(NOW / 1000) - 5 } }, okMe)),
    ).rejects.toThrow('expired');
    await expect(run(respond(okDebug, okMe))).resolves.toBeDefined();
  });

  it('rejects when the profile belongs to a different user than the token', async () => {
    await expect(run(respond(okDebug, { ...okMe, id: '111' }))).rejects.toThrow('user id mismatch');
  });

  it('rejects an account that shared no email (a phone-only Facebook account)', async () => {
    await expect(run(respond(okDebug, { id: '999', name: 'X' }))).rejects.toThrow('no email');
  });

  it('turns a Facebook outage into a SocialTokenError, not a crash', async () => {
    await expect(run(respond(new Error('ECONNRESET'), okMe))).rejects.toThrow(SocialTokenError);
    await expect(run(respond(okDebug, new Error('503')))).rejects.toThrow(SocialTokenError);
  });
});
