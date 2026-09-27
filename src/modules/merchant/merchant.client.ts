import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosError } from 'axios';
import { MerchantConfig } from './merchant.config';
import { MerchantProductInput } from './merchant-product.mapper';
import { MerchantAuthService } from './merchant.auth';

/**
 * Thin wrapper over the Google Merchant API Products sub-API.
 *
 * REST over axios rather than a generated client on purpose: the Merchant API
 * is versioned in its URL, so keeping the endpoint in one constant lets the
 * version move without a dependency bump, and the request bodies stay exactly
 * the shapes the mapper produces (easy to inspect in a dry run).
 *
 * Auth is delegated to MerchantAuthService, which uses either an explicit
 * service-account key or — when none is set and the API is running on a GCP
 * VM — the VM's own attached service account via Application Default
 * Credentials. Either way the account must be added as a user on the Merchant
 * Center account; no OAuth screen, no refresh tokens to store.
 */

/**
 * Merchant API version. v1beta was shut off on 2026-02-28 and every call
 * returned HTTP 409 telling us to upgrade, so this is pinned to v1.
 *
 * Kept as a single constant because the version lives in the URL: moving it
 * again is a one-line change, which is the whole reason this client is REST
 * over axios rather than a generated SDK.
 */
const API_BASE = 'https://merchantapi.googleapis.com/products/v1';

@Injectable()
export class MerchantClient {
  private readonly logger = new Logger(MerchantClient.name);

  constructor(private readonly auth: MerchantAuthService) {}

  private token(cfg: MerchantConfig): Promise<string> {
    return this.auth.token(cfg);
  }

  /** Insert or update one product input. */
  async upsertProduct(cfg: MerchantConfig, product: MerchantProductInput): Promise<void> {
    const account = `accounts/${cfg.accountId}`;
    const dataSource = `${account}/dataSources/${cfg.dataSourceId}`;
    const url = `${API_BASE}/${account}/productInputs:insert?dataSource=${encodeURIComponent(dataSource)}`;
    await this.post(cfg, url, product);
  }

  /**
   * Delete one product input by offerId. Used to pull a product that is no
   * longer sellable, so the listing does not outlive the offer.
   */
  async deleteProduct(cfg: MerchantConfig, offerId: string, contentLanguage: string, feedLabel: string): Promise<void> {
    const account = `accounts/${cfg.accountId}`;
    const dataSource = `${account}/dataSources/${cfg.dataSourceId}`;
    // The productInput name encodes contentLanguage~feedLabel~offerId. v1
    // dropped the leading channel segment along with the `channel` field, so
    // the old `online~en~IN~sku` form no longer resolves.
    const name = `${account}/productInputs/${contentLanguage}~${feedLabel}~${offerId}`;
    const url = `${API_BASE}/${name}?dataSource=${encodeURIComponent(dataSource)}`;
    try {
      const token = await this.token(cfg);
      await axios.delete(url, { headers: { Authorization: `Bearer ${token}` }, timeout: 30000 });
    } catch (e) {
      // A 404 means it was already gone — that is the desired end state.
      const status = (e as AxiosError).response?.status;
      if (status === 404) return;
      throw this.explain(e as AxiosError);
    }
  }

  private async post(cfg: MerchantConfig, url: string, body: unknown): Promise<void> {
    const token = await this.token(cfg);
    try {
      await axios.post(url, body, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        timeout: 30000,
      });
    } catch (e) {
      throw this.explain(e as AxiosError);
    }
  }

  /** Turn Google's error body into a one-line message worth logging. */
  private explain(e: AxiosError): Error {
    const status = e.response?.status;
    const data = e.response?.data as { error?: { message?: string } } | undefined;
    const msg = data?.error?.message || e.message;
    return new Error(`Merchant API ${status ?? ''}: ${msg}`.trim());
  }
}
