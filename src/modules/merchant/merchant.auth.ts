import { Injectable, Logger } from '@nestjs/common';
import { GoogleAuth, JWT } from 'google-auth-library';
import { MerchantConfig } from './merchant.config';

/**
 * How the Merchant API calls are authenticated.
 *
 * Two modes, tried in this order:
 *
 *  1. `key`  — an explicit service-account key in GOOGLE_MERCHANT_CREDENTIALS.
 *              Works anywhere, including off GCP, and is what you want if the
 *              Merchant Center account belongs to a different Google project.
 *
 *  2. `adc`  — Application Default Credentials. The API runs on a GCP VM, and
 *              a GCP VM already has a service account attached to it. The
 *              metadata server will mint tokens for it on request, so no key
 *              needs to be created, downloaded, pasted into a .env or rotated.
 *              This is both less work and safer: a downloaded private key is a
 *              long-lived secret sitting in a file, whereas metadata tokens are
 *              short-lived and cannot leak from the repo or a backup.
 *
 * ADC is not magic — Google still has to know the caller is allowed near the
 * Merchant Center account. The VM's service-account email must be added under
 * Merchant Center → People and access, exactly as a downloaded key's
 * client_email would have to be. `identity()` exists to tell the admin which
 * email that is, because with ADC there is no key file to read it out of.
 */

export const MERCHANT_SCOPE = 'https://www.googleapis.com/auth/content';

/** How long to wait on the GCP metadata server before deciding we are not on GCP. */
const IDENTITY_TIMEOUT_MS = 4000;

export type MerchantAuthMode = 'key' | 'adc' | 'none';

export interface MerchantIdentity {
  mode: MerchantAuthMode;
  /** The service account Google will see. Null when nothing is available. */
  email: string | null;
  /** Populated when mode is 'none', explaining what went wrong. */
  reason?: string;
}

@Injectable()
export class MerchantAuthService {
  private readonly logger = new Logger(MerchantAuthService.name);

  private jwt: JWT | null = null;
  private jwtEmail: string | null = null;
  private adc: GoogleAuth | null = null;

  /** Lazily built, then reused so tokens cache across calls. */
  private googleAuth(): GoogleAuth {
    if (!this.adc) this.adc = new GoogleAuth({ scopes: [MERCHANT_SCOPE] });
    return this.adc;
  }

  private jwtFor(cfg: MerchantConfig): JWT {
    const creds = cfg.credentials!;
    // Rebuild only when the key actually changed, so the cached access token
    // survives ordinary calls.
    if (!this.jwt || this.jwtEmail !== creds.client_email) {
      this.jwt = new JWT({
        email: creds.client_email,
        key: creds.private_key,
        scopes: [MERCHANT_SCOPE],
      });
      this.jwtEmail = creds.client_email;
    }
    return this.jwt;
  }

  /**
   * Which identity will be used, without making a Merchant API call.
   *
   * Never throws: off GCP and with no key configured, the metadata lookup
   * fails or hangs, and the honest answer is mode 'none' with a reason the
   * admin panel can display.
   */
  async identity(cfg: MerchantConfig): Promise<MerchantIdentity> {
    if (cfg.credentials) {
      return { mode: 'key', email: cfg.credentials.client_email };
    }

    try {
      // Bounded: the metadata server answers in milliseconds on GCP, but
      // resolves slowly or not at all elsewhere, and this runs inside the
      // admin's "Check status" request.
      const email = await this.withTimeout(
        this.googleAuth().getCredentials().then((c) => c.client_email ?? null),
        IDENTITY_TIMEOUT_MS,
      );
      if (!email) {
        return {
          mode: 'none',
          email: null,
          reason:
            'Application Default Credentials resolved but exposed no service-account email.',
        };
      }
      return { mode: 'adc', email };
    } catch (e) {
      const message = (e as Error).message;
      this.logger.warn(`No Merchant Center credentials available: ${message}`);
      return {
        mode: 'none',
        email: null,
        reason:
          'No service account available. Either run the API on a GCP VM with a service account attached, or set GOOGLE_MERCHANT_CREDENTIALS.',
      };
    }
  }

  /** A bearer token for the Merchant API. Throws when no identity is available. */
  async token(cfg: MerchantConfig): Promise<string> {
    if (cfg.credentials) {
      const { token } = await this.jwtFor(cfg).getAccessToken();
      if (!token) throw new Error('Could not obtain a Google access token from the configured key');
      return token;
    }

    const client = await this.googleAuth().getClient();
    const { token } = await client.getAccessToken();
    if (!token) {
      throw new Error(
        'Could not obtain a Google access token from Application Default Credentials',
      );
    }
    return token;
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out after ${ms}ms (not running on GCP?)`)),
        ms,
      );
      promise.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  }
}
