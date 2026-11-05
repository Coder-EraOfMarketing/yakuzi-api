import * as crypto from 'crypto';
import axios from 'axios';

/**
 * Verification of the credentials Apple and Facebook hand the browser.
 *
 * Deliberately dependency-free, for the same reason Google sign-in uses
 * tokeninfo rather than google-auth-library: the deploy runs `npm ci` on the
 * server, so a new package is a deploy-time risk for the whole API. Node's own
 * crypto verifies an RS256 signature from a JWK, and axios is already a
 * dependency.
 *
 * Every failure is a SocialTokenError. The caller turns all of them into one
 * generic 401 for the user and logs the reason; the distinction between "bad
 * signature" and "wrong audience" is not the user's problem and is not
 * something to hand an attacker.
 */
export class SocialTokenError extends Error {}

export interface VerifiedSocialIdentity {
  /** The provider's stable id for this person (Apple `sub`, Facebook `id`). */
  providerUserId: string;
  email: string;
  displayName: string;
}

type Jwk = crypto.JsonWebKey & { kid?: string };
export interface JwksSource {
  getKeys(): Promise<Jwk[]>;
}

const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';
const JWKS_TTL_MS = 60 * 60 * 1000;

/** Apple's signing keys, cached for an hour: they rotate rarely and every login would otherwise cost a round trip. */
export class AppleJwks implements JwksSource {
  private cache: { keys: Jwk[]; fetchedAt: number } | null = null;

  async getKeys(forceRefresh = false): Promise<Jwk[]> {
    const fresh = this.cache && Date.now() - this.cache.fetchedAt < JWKS_TTL_MS;
    if (!forceRefresh && fresh) return this.cache!.keys;
    const res = await axios.get<{ keys: Jwk[] }>(APPLE_JWKS_URL, { timeout: 8000 });
    this.cache = { keys: res.data?.keys ?? [], fetchedAt: Date.now() };
    return this.cache.keys;
  }
}

const b64urlToBuffer = (s: string): Buffer => Buffer.from(s, 'base64url');

function parseJwt(token: string): {
  header: { alg?: string; kid?: string };
  claims: Record<string, unknown>;
  signingInput: string;
  signature: Buffer;
} {
  const parts = token.split('.');
  if (parts.length !== 3) throw new SocialTokenError('not a JWT');
  try {
    return {
      header: JSON.parse(b64urlToBuffer(parts[0]).toString('utf8')),
      claims: JSON.parse(b64urlToBuffer(parts[1]).toString('utf8')),
      signingInput: `${parts[0]}.${parts[1]}`,
      signature: b64urlToBuffer(parts[2]),
    };
  } catch {
    throw new SocialTokenError('malformed JWT');
  }
}

/**
 * Verifies an Apple "identity token" (the id_token Sign in with Apple returns).
 *
 * Checks the RS256 signature against Apple's published keys, then the claims a
 * valid signature does NOT cover: a perfectly valid token issued to a
 * DIFFERENT application must not be accepted as a login to this one.
 */
export async function verifyAppleIdentityToken(
  idToken: string,
  clientId: string,
  jwks: JwksSource,
  now: number = Date.now(),
): Promise<VerifiedSocialIdentity> {
  const { header, claims, signingInput, signature } = parseJwt(idToken);

  // Pinning the algorithm closes the classic "alg: none / HS256 with the public
  // key as the secret" downgrade: we only ever accept what Apple signs with.
  if (header.alg !== 'RS256') throw new SocialTokenError(`unexpected alg ${header.alg}`);
  if (!header.kid) throw new SocialTokenError('no kid');

  let keys = await jwks.getKeys();
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk && jwks instanceof AppleJwks) {
    // Apple rotated since we cached. One forced refresh, then give up.
    keys = await jwks.getKeys(true);
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) throw new SocialTokenError('signing key not found');

  const valid = crypto.verify(
    'RSA-SHA256',
    Buffer.from(signingInput),
    crypto.createPublicKey({ key: jwk, format: 'jwk' }),
    signature,
  );
  if (!valid) throw new SocialTokenError('bad signature');

  if (claims.iss !== APPLE_ISSUER) throw new SocialTokenError('wrong issuer');
  if (claims.aud !== clientId) throw new SocialTokenError('wrong audience');

  const exp = Number(claims.exp);
  if (!Number.isFinite(exp) || exp * 1000 <= now) throw new SocialTokenError('expired');

  if (typeof claims.sub !== 'string' || !claims.sub) throw new SocialTokenError('no subject');

  // Apple sends this as a boolean or as the string "true".
  if (String(claims.email_verified) !== 'true') throw new SocialTokenError('email not verified');
  const email = String(claims.email ?? '').trim().toLowerCase();
  if (!email) throw new SocialTokenError('no email');

  // Apple puts the person's name in a separate first-login-only payload, not
  // the token, so there is nothing to read here. The profile starts blank.
  return { providerUserId: claims.sub, email, displayName: '' };
}

export interface HttpGet {
  get<T>(url: string, config?: { params?: Record<string, string>; timeout?: number }): Promise<{ data: T }>;
}

const GRAPH = 'https://graph.facebook.com';

/**
 * Verifies a Facebook user access token and returns who it belongs to.
 *
 * debug_token is the step that matters: without it, a token Facebook issued to
 * ANY other app would log a stranger in here. It must report the token valid,
 * unexpired and issued for THIS app id. The app access token (`id|secret`) used
 * to ask is server-side only and never reaches the browser.
 */
export async function verifyFacebookAccessToken(
  accessToken: string,
  appId: string,
  appSecret: string,
  http: HttpGet = axios,
  now: number = Date.now(),
): Promise<VerifiedSocialIdentity> {
  let debug: { data?: { is_valid?: boolean; app_id?: string; user_id?: string; expires_at?: number } };
  try {
    const res = await http.get<typeof debug>(`${GRAPH}/debug_token`, {
      params: { input_token: accessToken, access_token: `${appId}|${appSecret}` },
      timeout: 8000,
    });
    debug = res.data;
  } catch {
    throw new SocialTokenError('debug_token call failed');
  }

  const d = debug?.data;
  if (!d?.is_valid) throw new SocialTokenError('token not valid');
  if (String(d.app_id) !== String(appId)) throw new SocialTokenError('wrong app');
  // expires_at is 0 for tokens that never expire; only a positive past value is expired.
  if (d.expires_at && d.expires_at * 1000 <= now) throw new SocialTokenError('expired');

  let profile: { id?: string; name?: string; email?: string };
  try {
    const res = await http.get<typeof profile>(`${GRAPH}/me`, {
      params: { fields: 'id,name,email', access_token: accessToken },
      timeout: 8000,
    });
    profile = res.data;
  } catch {
    throw new SocialTokenError('profile call failed');
  }

  if (!profile?.id) throw new SocialTokenError('no id');
  // The id debug_token vouched for and the id /me returned must be the same person.
  if (d.user_id && String(d.user_id) !== String(profile.id)) {
    throw new SocialTokenError('user id mismatch');
  }
  const email = (profile.email ?? '').trim().toLowerCase();
  if (!email) throw new SocialTokenError('no email');

  return { providerUserId: String(profile.id), email, displayName: (profile.name ?? '').trim() };
}
