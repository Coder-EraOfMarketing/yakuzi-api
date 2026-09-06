import {
  Injectable,
  Logger,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError } from 'axios';
import * as crypto from 'crypto';
import { normalizeShopifyDomain } from '../store-url.util';
import { ExternalProductPage } from './external-product.types';

/** Only the fields of Shopify's product payload this integration reads. */
interface ShopifyRawProduct {
  id: number;
  title?: string;
  variants?: Array<{
    id: number;
    sku?: string;
    title?: string;
    inventory_quantity?: number;
    inventory_item_id?: number;
  }>;
}

/**
 * Shopify OAuth (the public-app "authorization code grant" flow).
 *
 * Yukizi is an external SaaS platform connecting stores owned by different
 * merchants, so this is the correct flow — not a private/custom app token.
 *
 * Reference shape:
 *   GET  https://{shop}/admin/oauth/authorize?client_id&scope&redirect_uri&state
 *   POST https://{shop}/admin/oauth/access_token {client_id, client_secret, code}
 */

/** Shopify Admin API version this integration is written against. */
export const SHOPIFY_API_VERSION = '2025-01';

/**
 * Least privilege. Each scope maps to something this feature actually does:
 *  - read_products        : import listings and their variants/SKUs
 *  - read_inventory       : read stock levels for mapping and reconciliation
 *  - write_inventory      : push Yukizi quantities out (export / two-way)
 *  - read_locations       : inventory levels are per-location; we cannot set a
 *                           quantity without knowing the location id
 * Deliberately NOT requested: orders, customers, price/product write. Yukizi
 * derives stock changes from the inventory webhooks, so order scopes — which
 * carry personal data and need protected-data approval — are unnecessary.
 */
export const SHOPIFY_SCOPES = [
  'read_products',
  'read_inventory',
  'write_inventory',
  'read_locations',
];

export interface ShopifyCredentials {
  accessToken: string;
  scope: string;
  shopDomain: string;
}

export interface ShopifyShopInfo {
  id: number;
  name: string;
  domain: string;
  myshopifyDomain: string;
  email?: string;
  currency?: string;
}

@Injectable()
export class ShopifyProvider {
  private readonly logger = new Logger(ShopifyProvider.name);

  constructor(private readonly configService: ConfigService) {}

  private get clientId(): string | undefined {
    return this.configService.get<string>('SHOPIFY_CLIENT_ID')?.trim();
  }

  private get clientSecret(): string | undefined {
    return this.configService.get<string>('SHOPIFY_CLIENT_SECRET')?.trim();
  }

  private get redirectUri(): string | undefined {
    return this.configService.get<string>('SHOPIFY_REDIRECT_URI')?.trim();
  }

  /**
   * Whether the Shopify app is configured at all. The UI uses this to show
   * "unavailable" rather than sending a seller into a broken handshake.
   */
  isConfigured(): boolean {
    return Boolean(this.clientId && this.clientSecret && this.redirectUri);
  }

  /**
   * Builds the consent URL the seller is redirected to. `state` is generated
   * and persisted by the caller; it comes back on the callback and is what
   * proves the response belongs to a flow we started.
   */
  buildAuthorizationUrl(shopDomain: string, state: string): string {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException(
        'Shopify connections are not available yet. Please contact Yukizi support.',
      );
    }
    const shop = normalizeShopifyDomain(shopDomain);
    const params = new URLSearchParams({
      client_id: this.clientId as string,
      scope: SHOPIFY_SCOPES.join(','),
      redirect_uri: this.redirectUri as string,
      state,
    });
    return `https://${shop}/admin/oauth/authorize?${params.toString()}`;
  }

  /**
   * Validates the HMAC Shopify appends to the callback query string.
   *
   * Per Shopify's spec the signature covers every query parameter except
   * `hmac` and `signature`, sorted, joined as key=value pairs with `&`.
   * Without this check anyone could hit our callback with a `code` of their
   * choosing.
   */
  verifyCallbackHmac(query: Record<string, unknown>): boolean {
    const secret = this.clientSecret;
    if (!secret) return false;

    const provided = typeof query.hmac === 'string' ? query.hmac : '';
    if (!provided) return false;

    const message = Object.keys(query)
      .filter((key) => key !== 'hmac' && key !== 'signature')
      .sort()
      .map((key) => `${key}=${String(query[key] ?? '')}`)
      .join('&');

    const digest = crypto
      .createHmac('sha256', secret)
      .update(message)
      .digest('hex');

    return this.safeCompare(digest, provided);
  }

  /**
   * Validates the X-Shopify-Hmac-Sha256 header on an incoming webhook. This is
   * base64 over the RAW request body — a re-serialised JSON object will not
   * match, which is why the raw body is captured in main.ts.
   */
  verifyWebhookHmac(rawBody: Buffer | undefined, headerHmac?: string): boolean {
    const secret = this.clientSecret;
    if (!secret || !headerHmac || !rawBody?.length) return false;

    const digest = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('base64');

    return this.safeCompare(digest, headerHmac);
  }

  /** Length-guarded constant-time compare (timingSafeEqual throws otherwise). */
  private safeCompare(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  }

  /**
   * Exchanges the one-time authorization code for a permanent Admin API access
   * token. The token is returned to the caller for encryption — it is never
   * logged and never leaves the server.
   */
  async exchangeCodeForToken(
    shopDomain: string,
    code: string,
  ): Promise<ShopifyCredentials> {
    const shop = normalizeShopifyDomain(shopDomain);
    try {
      const { data } = await axios.post<{
        access_token: string;
        scope: string;
      }>(
        `https://${shop}/admin/oauth/access_token`,
        {
          client_id: this.clientId,
          client_secret: this.clientSecret,
          code,
        },
        { timeout: 15_000 },
      );

      if (!data?.access_token) {
        throw new BadRequestException(
          'Shopify did not return an access token. Please try connecting again.',
        );
      }

      return {
        accessToken: data.access_token,
        scope: data.scope ?? SHOPIFY_SCOPES.join(','),
        shopDomain: shop,
      };
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      // Never log the response body — it contains the token on success and
      // may echo the client secret on some error shapes.
      const status = (error as AxiosError)?.response?.status;
      this.logger.error(
        `Shopify token exchange failed for ${shop} (status ${status ?? 'none'})`,
      );
      throw new BadRequestException(
        'We could not complete the Shopify connection. Please try again.',
      );
    }
  }

  /**
   * Reads shop metadata so the seller sees the store they just connected
   * rather than a bare domain. Also doubles as a credential health check.
   */
  async fetchShopInfo(
    shopDomain: string,
    accessToken: string,
  ): Promise<ShopifyShopInfo> {
    const shop = normalizeShopifyDomain(shopDomain);
    const { data } = await axios.get<{ shop: Record<string, unknown> }>(
      `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/shop.json`,
      {
        headers: { 'X-Shopify-Access-Token': accessToken },
        timeout: 15_000,
      },
    );

    const info = data?.shop ?? {};
    return {
      id: Number(info.id ?? 0),
      name: String(info.name ?? shop),
      domain: String(info.domain ?? shop),
      myshopifyDomain: String(info.myshopify_domain ?? shop),
      email: info.email ? String(info.email) : undefined,
      currency: info.currency ? String(info.currency) : undefined,
    };
  }

  /**
   * Health probe used by the status cron. Returns true when the stored token
   * still works, false when Shopify rejects it (uninstalled app, revoked
   * token) — the caller then flips the integration to "Action required".
   */
  async verifyCredentials(
    shopDomain: string,
    accessToken: string,
  ): Promise<boolean> {
    try {
      await this.fetchShopInfo(shopDomain, accessToken);
      return true;
    } catch (error) {
      const status = (error as AxiosError)?.response?.status;
      if (status === 401 || status === 403) return false;
      // A 5xx or a timeout is Shopify being unwell, not a dead credential.
      throw error;
    }
  }

  /**
   * One page of products, with the cursor for the next page.
   *
   * Shopify's REST pagination is cursor-based via the `Link` header — offset
   * paging was removed. The cursor is opaque and must be passed back verbatim;
   * while it is present Shopify rejects any parameter other than `limit`.
   */
  async fetchProductsPage(
    shopDomain: string,
    accessToken: string,
    cursor?: string | null,
    limit = 250,
  ): Promise<ExternalProductPage> {
    const shop = normalizeShopifyDomain(shopDomain);
    const params = new URLSearchParams({ limit: String(Math.min(250, limit)) });
    if (cursor) params.set('page_info', cursor);

    const response = await axios.get<{ products: ShopifyRawProduct[] }>(
      `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/products.json?${params.toString()}`,
      {
        headers: { 'X-Shopify-Access-Token': accessToken },
        timeout: 30_000,
      },
    );

    const products: ExternalProductPage['products'] = [];
    for (const product of response.data?.products ?? []) {
      // A Shopify product always has at least one variant, and the VARIANT is
      // what carries the SKU and the stock — so variants, not products, are
      // what map onto Yukizi listings.
      for (const variant of product.variants ?? []) {
        products.push({
          externalProductId: String(product.id),
          externalVariantId: String(variant.id),
          sku: variant.sku?.trim() || null,
          title:
            variant.title && variant.title !== 'Default Title'
              ? `${product.title ?? 'Product'} — ${variant.title}`
              : (product.title ?? null),
          quantity:
            typeof variant.inventory_quantity === 'number'
              ? variant.inventory_quantity
              : null,
          // Shopify stock is always merchant-controlled from our side.
          fulfillmentChannel: 'MERCHANT' as const,
          // Needed later to write a quantity back: Shopify keys inventory on
          // the inventory item, not the variant.
          inventoryRef: variant.inventory_item_id
            ? String(variant.inventory_item_id)
            : null,
        });
      }
    }

    return { products, nextCursor: this.parseNextCursor(response.headers?.link) };
  }

  /**
   * The location inventory is tracked against.
   *
   * Shopify inventory is per-location, so a quantity cannot be set without
   * one. Sellers on Yukizi are single-location in practice; the first active
   * location is used, and a store with several would need an explicit choice
   * (deliberately not guessed here).
   */
  async fetchPrimaryLocationId(
    shopDomain: string,
    accessToken: string,
  ): Promise<string | null> {
    const shop = normalizeShopifyDomain(shopDomain);
    const { data } = await axios.get<{
      locations: Array<{ id: number; active?: boolean }>;
    }>(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/locations.json`, {
      headers: { 'X-Shopify-Access-Token': accessToken },
      timeout: 15_000,
    });

    const locations = data?.locations ?? [];
    const active = locations.find((l) => l.active !== false) ?? locations[0];
    return active?.id ? String(active.id) : null;
  }

  /**
   * Sets the absolute quantity for one inventory item.
   *
   * `set` rather than `adjust` on purpose: Yukizi knows the number it wants,
   * and a delta would compound if a request were ever retried after a
   * response was lost.
   */
  async setInventoryLevel(
    shopDomain: string,
    accessToken: string,
    inventoryItemId: string,
    locationId: string,
    available: number,
  ): Promise<void> {
    const shop = normalizeShopifyDomain(shopDomain);
    await axios.post(
      `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/inventory_levels/set.json`,
      {
        location_id: Number(locationId),
        inventory_item_id: Number(inventoryItemId),
        available,
      },
      {
        headers: { 'X-Shopify-Access-Token': accessToken },
        timeout: 20_000,
      },
    );
  }

  /**
   * Extracts the `page_info` of the rel="next" link, or null on the last page.
   * Header shape:
   *   <https://shop/admin/api/.../products.json?page_info=XYZ&limit=250>; rel="next"
   */
  private parseNextCursor(linkHeader?: unknown): string | null {
    if (typeof linkHeader !== 'string' || !linkHeader) return null;
    for (const part of linkHeader.split(',')) {
      if (!part.includes('rel="next"')) continue;
      const url = part.match(/<([^>]+)>/)?.[1];
      if (!url) continue;
      try {
        return new URL(url).searchParams.get('page_info');
      } catch {
        return null;
      }
    }
    return null;
  }

  /**
   * Registers a webhook subscription. Returns the Shopify webhook id so
   * disconnect can delete exactly what we created.
   */
  async registerWebhook(
    shopDomain: string,
    accessToken: string,
    topic: string,
    address: string,
  ): Promise<string | null> {
    const shop = normalizeShopifyDomain(shopDomain);
    try {
      const { data } = await axios.post<{ webhook: { id: number } }>(
        `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/webhooks.json`,
        { webhook: { topic, address, format: 'json' } },
        {
          headers: { 'X-Shopify-Access-Token': accessToken },
          timeout: 15_000,
        },
      );
      return data?.webhook?.id ? String(data.webhook.id) : null;
    } catch (error) {
      const status = (error as AxiosError)?.response?.status;
      // 422 usually means "already subscribed to this topic+address", which is
      // fine and must not fail the connection.
      this.logger.warn(
        `Shopify webhook registration for ${topic} returned status ${status ?? 'none'}`,
      );
      return null;
    }
  }

  /** Best-effort cleanup on disconnect. */
  async deleteWebhook(
    shopDomain: string,
    accessToken: string,
    webhookId: string,
  ): Promise<void> {
    const shop = normalizeShopifyDomain(shopDomain);
    try {
      await axios.delete(
        `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/webhooks/${webhookId}.json`,
        {
          headers: { 'X-Shopify-Access-Token': accessToken },
          timeout: 15_000,
        },
      );
    } catch {
      // The app may already be uninstalled, which removes webhooks anyway.
      this.logger.warn(`Could not delete Shopify webhook ${webhookId}`);
    }
  }
}
