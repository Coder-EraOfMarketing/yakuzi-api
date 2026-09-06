import {
  Injectable,
  Logger,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError } from 'axios';
import { ExternalProductPage } from './external-product.types';

/** Only the fields of the Listings Items payload this integration reads. */
interface AmazonListingsResponse {
  items?: Array<{
    sku?: string;
    summaries?: Array<{ asin?: string; itemName?: string; productType?: string }>;
    fulfillmentAvailability?: Array<{
      fulfillmentChannelCode?: string;
      quantity?: number;
    }>;
  }>;
  pagination?: { nextToken?: string };
}

/**
 * Amazon Selling Partner API (SP-API) authorisation.
 *
 * The seller is sent to Seller Central's app-consent page for their region,
 * approves the Yukizi application, and Amazon returns an `spapi_oauth_code`.
 * That code is exchanged with Login with Amazon (LWA) for a REFRESH token —
 * the long-lived credential — from which short-lived access tokens are minted
 * server-side on every call.
 *
 * Explicitly not supported: storefront URLs, seller profile links, or Seller
 * Central passwords. None of those can authorise an API integration.
 */

export interface AmazonMarketplace {
  /** Value shown to the seller. */
  country: string;
  code: string;
  marketplaceId: string;
  /** SP-API endpoint group. */
  region: 'na' | 'eu' | 'fe';
}

/**
 * The marketplaces Yukizi offers. `marketplaceId` values are Amazon's public,
 * fixed identifiers.
 */
export const AMAZON_MARKETPLACES: AmazonMarketplace[] = [
  { country: 'India', code: 'IN', marketplaceId: 'A21TJRUUN4KGV', region: 'eu' },
  { country: 'United States', code: 'US', marketplaceId: 'ATVPDKIKX0DER', region: 'na' },
  { country: 'Canada', code: 'CA', marketplaceId: 'A2EUQ1WTGCTBG2', region: 'na' },
  { country: 'Mexico', code: 'MX', marketplaceId: 'A1AM78C64UM0Y8', region: 'na' },
  { country: 'United Kingdom', code: 'GB', marketplaceId: 'A1F83G8C2ARO7P', region: 'eu' },
  { country: 'Germany', code: 'DE', marketplaceId: 'A1PA6795UKMFR9', region: 'eu' },
  { country: 'France', code: 'FR', marketplaceId: 'A13V1IB3VIYZZH', region: 'eu' },
  { country: 'Italy', code: 'IT', marketplaceId: 'APJ6JRA9NG5V4', region: 'eu' },
  { country: 'Spain', code: 'ES', marketplaceId: 'A1RKKUPIHCS9HS', region: 'eu' },
  { country: 'Netherlands', code: 'NL', marketplaceId: 'A1805IZSGTT6HS', region: 'eu' },
  { country: 'United Arab Emirates', code: 'AE', marketplaceId: 'A2VIGQ35RCS4UG', region: 'eu' },
  { country: 'Saudi Arabia', code: 'SA', marketplaceId: 'A17E79C6D8DWNP', region: 'eu' },
  { country: 'Australia', code: 'AU', marketplaceId: 'A39IBJ37TRP1C6', region: 'fe' },
  { country: 'Japan', code: 'JP', marketplaceId: 'A1VC38T7YXB528', region: 'fe' },
  { country: 'Singapore', code: 'SG', marketplaceId: 'A19VAU5U5O7RUS', region: 'fe' },
];

/** Seller Central consent hosts, per marketplace. */
const SELLER_CENTRAL_HOSTS: Record<string, string> = {
  IN: 'sellercentral.amazon.in',
  US: 'sellercentral.amazon.com',
  CA: 'sellercentral.amazon.ca',
  MX: 'sellercentral.amazon.com.mx',
  GB: 'sellercentral.amazon.co.uk',
  DE: 'sellercentral.amazon.de',
  FR: 'sellercentral.amazon.fr',
  IT: 'sellercentral.amazon.it',
  ES: 'sellercentral.amazon.es',
  NL: 'sellercentral.amazon.nl',
  AE: 'sellercentral.amazon.ae',
  SA: 'sellercentral.amazon.sa',
  AU: 'sellercentral.amazon.com.au',
  JP: 'sellercentral.amazon.co.jp',
  SG: 'sellercentral.amazon.sg',
};

/** SP-API host per region group. */
export const SP_API_HOSTS: Record<string, string> = {
  na: 'sellingpartnerapi-na.amazon.com',
  eu: 'sellingpartnerapi-eu.amazon.com',
  fe: 'sellingpartnerapi-fe.amazon.com',
};

const LWA_TOKEN_ENDPOINT = 'https://api.amazon.com/auth/o2/token';

export interface AmazonCredentials {
  refreshToken: string;
  sellingPartnerId: string;
  marketplaceId: string;
  region: string;
}

@Injectable()
export class AmazonProvider {
  private readonly logger = new Logger(AmazonProvider.name);

  /**
   * Short-lived access tokens are cached in memory until shortly before they
   * expire. Amazon issues them for one hour and rate-limits the token
   * endpoint, so re-minting per request would be wasteful and fragile.
   */
  private readonly accessTokenCache = new Map<
    string,
    { token: string; expiresAt: number }
  >();

  constructor(private readonly configService: ConfigService) {}

  private get clientId(): string | undefined {
    return this.configService.get<string>('AMAZON_LWA_CLIENT_ID')?.trim();
  }

  private get clientSecret(): string | undefined {
    return this.configService.get<string>('AMAZON_LWA_CLIENT_SECRET')?.trim();
  }

  private get appId(): string | undefined {
    return this.configService.get<string>('AMAZON_SP_API_APP_ID')?.trim();
  }

  private get redirectUri(): string | undefined {
    return this.configService.get<string>('AMAZON_REDIRECT_URI')?.trim();
  }

  isConfigured(): boolean {
    return Boolean(
      this.clientId && this.clientSecret && this.appId && this.redirectUri,
    );
  }

  listMarketplaces(): AmazonMarketplace[] {
    return AMAZON_MARKETPLACES;
  }

  findMarketplace(marketplaceId: string): AmazonMarketplace | undefined {
    return AMAZON_MARKETPLACES.find((m) => m.marketplaceId === marketplaceId);
  }

  /**
   * Picks a sensible default marketplace from the seller's own address rather
   * than making them choose blind. Yukizi sellers are India-based today, so an
   * unrecognised country still lands on IN.
   */
  defaultMarketplaceFor(country?: string | null): AmazonMarketplace {
    const normalized = (country ?? '').trim().toLowerCase();
    const match = AMAZON_MARKETPLACES.find(
      (m) =>
        m.country.toLowerCase() === normalized ||
        m.code.toLowerCase() === normalized,
    );
    return match ?? (AMAZON_MARKETPLACES[0] as AmazonMarketplace);
  }

  /**
   * Builds the Seller Central consent URL for the chosen marketplace.
   *
   * `version=beta` is required while the SP-API app is in draft; once the app
   * is published in the Amazon store the parameter is dropped. It is
   * controlled by AMAZON_SP_API_APP_DRAFT so going live is a config change,
   * not a code change.
   */
  buildAuthorizationUrl(marketplaceId: string, state: string): string {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException(
        'Amazon connections are not available yet. Please contact Yukizi support.',
      );
    }
    const marketplace = this.findMarketplace(marketplaceId);
    if (!marketplace) {
      throw new BadRequestException('Choose a supported Amazon marketplace.');
    }

    const host =
      SELLER_CENTRAL_HOSTS[marketplace.code] ?? SELLER_CENTRAL_HOSTS.US;
    const params = new URLSearchParams({
      application_id: this.appId as string,
      state,
      redirect_uri: this.redirectUri as string,
    });

    const isDraft =
      (this.configService.get<string>('AMAZON_SP_API_APP_DRAFT') ?? 'true')
        .trim()
        .toLowerCase() !== 'false';
    if (isDraft) params.set('version', 'beta');

    return `https://${host}/apps/authorize/consent?${params.toString()}`;
  }

  /**
   * Exchanges the one-time `spapi_oauth_code` for a refresh token via LWA.
   * The refresh token is the credential we persist (encrypted); access tokens
   * are derived from it and never stored.
   */
  async exchangeCodeForRefreshToken(code: string): Promise<string> {
    try {
      const { data } = await axios.post<{
        refresh_token: string;
        access_token: string;
        expires_in: number;
      }>(
        LWA_TOKEN_ENDPOINT,
        new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          client_id: this.clientId as string,
          client_secret: this.clientSecret as string,
          redirect_uri: this.redirectUri as string,
        }).toString(),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 15_000,
        },
      );

      if (!data?.refresh_token) {
        throw new BadRequestException(
          'Amazon did not return a refresh token. Please try connecting again.',
        );
      }
      return data.refresh_token;
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      const status = (error as AxiosError)?.response?.status;
      this.logger.error(
        `Amazon LWA code exchange failed (status ${status ?? 'none'})`,
      );
      throw new BadRequestException(
        'We could not complete the Amazon connection. Please try again.',
      );
    }
  }

  /**
   * Mints (or reuses) a short-lived access token. Cached per refresh token
   * with a 60-second safety margin.
   *
   * The cache key is a hash-free slice of the refresh token only because it
   * never leaves this process; it is never logged.
   */
  async getAccessToken(refreshToken: string): Promise<string> {
    const cacheKey = refreshToken.slice(-24);
    const cached = this.accessTokenCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.token;
    }

    const { data } = await axios.post<{
      access_token: string;
      expires_in: number;
    }>(
      LWA_TOKEN_ENDPOINT,
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: this.clientId as string,
        client_secret: this.clientSecret as string,
      }).toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15_000,
      },
    );

    const token = data?.access_token;
    if (!token) {
      throw new BadRequestException('Amazon did not issue an access token.');
    }

    this.accessTokenCache.set(cacheKey, {
      token,
      expiresAt: Date.now() + Math.max(0, (data.expires_in ?? 3600) - 60) * 1000,
    });
    return token;
  }

  /** Drops a cached token, e.g. after a disconnect. */
  forgetAccessToken(refreshToken: string): void {
    this.accessTokenCache.delete(refreshToken.slice(-24));
  }

  /**
   * Confirms the refresh token still works and returns the marketplace
   * participations, which is also how we learn the selling partner's own
   * identifiers. Returns null when Amazon rejects the credential.
   */
  async fetchParticipations(
    credentials: AmazonCredentials,
  ): Promise<Array<{ marketplaceId: string; storeName?: string }> | null> {
    const host = SP_API_HOSTS[credentials.region] ?? SP_API_HOSTS.na;
    try {
      const accessToken = await this.getAccessToken(credentials.refreshToken);
      const { data } = await axios.get<{
        payload?: Array<{
          marketplace?: { id?: string; name?: string };
          participation?: { isParticipating?: boolean };
        }>;
      }>(`https://${host}/sellers/v1/marketplaceParticipations`, {
        headers: { 'x-amz-access-token': accessToken },
        timeout: 20_000,
      });

      return (data?.payload ?? []).map((entry) => ({
        marketplaceId: String(entry.marketplace?.id ?? ''),
        storeName: entry.marketplace?.name
          ? String(entry.marketplace.name)
          : undefined,
      }));
    } catch (error) {
      const status = (error as AxiosError)?.response?.status;
      if (status === 401 || status === 403) return null;
      throw error;
    }
  }

  /**
   * One page of the seller's listings, via the Listings Items API
   * (`searchListingsItems`, 2021-08-01).
   *
   * FBA vs MFN is decided here and nowhere else. Amazon reports availability
   * per fulfilment channel: `DEFAULT` is merchant-fulfilled stock the seller
   * controls, anything else (AMAZON_NA, AMAZON_EU, …) is held in Amazon's
   * fulfilment centres. The two are emitted as separate rows with different
   * `fulfillmentChannel` values so that FBA quantities can be displayed but
   * never treated as seller-controlled stock.
   */
  async fetchListingsPage(
    credentials: AmazonCredentials,
    cursor?: string | null,
    pageSize = 20,
  ): Promise<ExternalProductPage> {
    const host = SP_API_HOSTS[credentials.region] ?? SP_API_HOSTS.na;
    const accessToken = await this.getAccessToken(credentials.refreshToken);

    const params: Record<string, string> = {
      marketplaceIds: credentials.marketplaceId,
      includedData: 'summaries,fulfillmentAvailability',
      // Amazon caps this endpoint at 20 per page.
      pageSize: String(Math.min(20, pageSize)),
    };
    if (cursor) params.pageToken = cursor;

    const { data } = await axios.get<AmazonListingsResponse>(
      `https://${host}/listings/2021-08-01/items/${encodeURIComponent(
        credentials.sellingPartnerId,
      )}`,
      {
        headers: { 'x-amz-access-token': accessToken },
        params,
        timeout: 30_000,
      },
    );

    const products: ExternalProductPage['products'] = [];

    for (const item of data?.items ?? []) {
      const sku = item.sku?.trim() || null;
      const summary = item.summaries?.[0];
      const asin = summary?.asin ?? null;
      const title = summary?.itemName ?? sku;
      // Captured now because a later quantity PATCH cannot be made without it.
      const productType = summary?.productType ?? null;

      const availability = item.fulfillmentAvailability ?? [];
      if (availability.length === 0) {
        // A listing with no availability block still needs a mapping row so
        // the seller can see it; quantity is genuinely unknown, not zero.
        products.push({
          externalProductId: sku ?? '',
          externalVariantId: null,
          sku,
          title,
          quantity: null,
          fulfillmentChannel: 'MERCHANT' as const,
          asin,
          productType,
        });
        continue;
      }

      for (const entry of availability) {
        const isMerchant =
          (entry.fulfillmentChannelCode ?? 'DEFAULT').toUpperCase() === 'DEFAULT';
        products.push({
          externalProductId: sku ?? '',
          // FBA and MFN availability for one SKU are distinct rows; the channel
          // code keeps their unique keys apart.
          externalVariantId: isMerchant ? null : entry.fulfillmentChannelCode ?? 'FBA',
          sku,
          title,
          quantity:
            typeof entry.quantity === 'number' ? entry.quantity : null,
          fulfillmentChannel: isMerchant
            ? ('MERCHANT' as const)
            : ('AMAZON_FBA' as const),
          asin,
          productType,
        });
      }
    }

    return { products, nextCursor: data?.pagination?.nextToken ?? null };
  }

  /**
   * Sets the merchant-fulfilled quantity for one SKU via a Listings Items
   * PATCH.
   *
   * Amazon requires `productType` on every patch, which is why it is captured
   * at import time. Only the DEFAULT (merchant) fulfilment channel is ever
   * written: FBA quantities belong to Amazon's fulfilment centres and are not
   * ours to set.
   */
  async setMerchantQuantity(
    credentials: AmazonCredentials,
    sku: string,
    productType: string,
    quantity: number,
  ): Promise<void> {
    const host = SP_API_HOSTS[credentials.region] ?? SP_API_HOSTS.na;
    const accessToken = await this.getAccessToken(credentials.refreshToken);

    await axios.patch(
      `https://${host}/listings/2021-08-01/items/${encodeURIComponent(
        credentials.sellingPartnerId,
      )}/${encodeURIComponent(sku)}`,
      {
        productType,
        patches: [
          {
            op: 'replace',
            path: '/attributes/fulfillment_availability',
            value: [
              {
                fulfillment_channel_code: 'DEFAULT',
                quantity,
              },
            ],
          },
        ],
      },
      {
        headers: {
          'x-amz-access-token': accessToken,
          'Content-Type': 'application/json',
        },
        params: { marketplaceIds: credentials.marketplaceId },
        timeout: 25_000,
      },
    );
  }

  /**
   * Health probe for the status cron. `false` means the seller must
   * reauthorise; a thrown error means Amazon is unavailable and the
   * connection should be left alone.
   */
  async verifyCredentials(credentials: AmazonCredentials): Promise<boolean> {
    const participations = await this.fetchParticipations(credentials);
    return participations !== null;
  }
}
