import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  IntegrationLogStatus,
  IntegrationProvider,
  SellerIntegration,
} from '@prisma/client';
import * as crypto from 'crypto';
import { PrismaService } from '../../database/prisma.service';
import { EncryptionService } from './encryption.service';
import { IntegrationsService } from './integrations.service';
import { PermanentIntegrationError } from './integration-import.service';
import { ShopifyProvider } from './providers/shopify.provider';
import { WooCommerceProvider } from './providers/woocommerce.provider';

/**
 * Subscribes Yukizi to the channel's change notifications.
 *
 * Until this runs, the webhook receivers built in phase 1 can never fire:
 * Shopify is never asked to send anything, and WooCommerce deliveries are
 * rejected because the per-webhook signing secret they are verified against
 * only exists once the subscription has been created here.
 *
 * Registration is idempotent — re-running replaces what we previously created
 * rather than accumulating duplicates on the seller's store.
 */
@Injectable()
export class IntegrationWebhookRegistrationService {
  private readonly logger = new Logger(
    IntegrationWebhookRegistrationService.name,
  );

  /** Inventory is the only thing phase 3 acts on. */
  private static readonly SHOPIFY_TOPICS = [
    'inventory_levels/update',
    // Not inventory, but the only reliable signal that our token just died.
    'app/uninstalled',
  ];

  private static readonly WOO_TOPICS = [
    'product.updated',
    'product.deleted',
  ];

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly encryption: EncryptionService,
    private readonly integrations: IntegrationsService,
    private readonly shopify: ShopifyProvider,
    private readonly woocommerce: WooCommerceProvider,
  ) {}

  private apiPublicUrl(): string {
    return (
      this.configService.get<string>('API_PUBLIC_URL')?.trim().replace(/\/$/, '') ||
      'https://yukizi.com/api'
    );
  }

  /**
   * Registers every topic this integration needs. Failures are reported but
   * not fatal: polling still keeps inventory correct, just less promptly, so
   * a store that blocks webhook creation is degraded rather than broken.
   */
  async registerAll(
    integration: SellerIntegration,
  ): Promise<{ registered: number; failed: number }> {
    const credentials = this.encryption.decrypt<Record<string, string>>(
      integration.encryptedCredentials,
    );
    if (!credentials) {
      throw new PermanentIntegrationError(
        'This connection needs to be reauthorized.',
      );
    }

    // Drop anything we registered before, so a re-run cannot leave the store
    // with two subscriptions pointing at us.
    await this.removeExisting(integration, credentials);

    let registered = 0;
    let failed = 0;

    if (integration.provider === IntegrationProvider.SHOPIFY) {
      const address = `${this.apiPublicUrl()}/integrations/shopify/webhook`;
      for (const topic of IntegrationWebhookRegistrationService.SHOPIFY_TOPICS) {
        const externalId = await this.shopify.registerWebhook(
          integration.externalAccountId,
          credentials.accessToken,
          topic,
          address,
        );
        if (!externalId) {
          failed += 1;
          continue;
        }
        await this.prisma.integrationWebhook.create({
          data: { integrationId: integration.id, externalId, topic },
        });
        registered += 1;
      }
    } else if (integration.provider === IntegrationProvider.WOOCOMMERCE) {
      const deliveryUrl = `${this.apiPublicUrl()}/integrations/woocommerce/webhook`;
      for (const topic of IntegrationWebhookRegistrationService.WOO_TOPICS) {
        // WooCommerce lets US choose the signing secret, so deliveries can be
        // verified. It is stored encrypted, never in plaintext.
        const secret = crypto.randomBytes(32).toString('base64url');
        const externalId = await this.woocommerce.registerWebhook(
          integration.externalStoreUrl ?? '',
          {
            consumerKey: credentials.consumerKey,
            consumerSecret: credentials.consumerSecret,
            keyPermissions: credentials.keyPermissions ?? 'read_write',
            storeUrl: integration.externalStoreUrl ?? '',
          },
          topic,
          deliveryUrl,
          secret,
        );
        if (!externalId) {
          failed += 1;
          continue;
        }
        await this.prisma.integrationWebhook.create({
          data: {
            integrationId: integration.id,
            externalId,
            topic,
            encryptedSecret: this.encryption.encrypt({ secret }),
          },
        });
        registered += 1;
      }
    } else {
      // Amazon notifications need an SQS destination Yukizi does not operate
      // yet, so this channel relies on the reconciliation sweep. Saying so is
      // better than pretending a subscription exists.
      return { registered: 0, failed: 0 };
    }

    await this.integrations.log(integration.sellerId, integration.id, {
      action: 'WEBHOOKS_REGISTERED',
      status:
        failed > 0 ? IntegrationLogStatus.WARNING : IntegrationLogStatus.SUCCESS,
      message:
        failed > 0
          ? `${registered} change notification(s) set up; ${failed} could not be created. Yukizi will still sync on a schedule.`
          : `${registered} change notification(s) set up.`,
    });

    return { registered, failed };
  }

  /** Deletes previously created subscriptions, on the store and locally. */
  private async removeExisting(
    integration: SellerIntegration,
    credentials: Record<string, string>,
  ): Promise<void> {
    const existing = await this.prisma.integrationWebhook.findMany({
      where: { integrationId: integration.id },
    });
    if (existing.length === 0) return;

    for (const webhook of existing) {
      try {
        if (integration.provider === IntegrationProvider.SHOPIFY) {
          await this.shopify.deleteWebhook(
            integration.externalAccountId,
            credentials.accessToken,
            webhook.externalId,
          );
        } else if (integration.provider === IntegrationProvider.WOOCOMMERCE) {
          await this.woocommerce.deleteWebhook(
            integration.externalStoreUrl ?? '',
            {
              consumerKey: credentials.consumerKey,
              consumerSecret: credentials.consumerSecret,
              keyPermissions: credentials.keyPermissions ?? 'read_write',
              storeUrl: integration.externalStoreUrl ?? '',
            },
            webhook.externalId,
          );
        }
      } catch {
        // The subscription may already be gone; the local row goes either way.
        this.logger.warn(
          `Could not delete existing webhook ${webhook.externalId}`,
        );
      }
    }

    await this.prisma.integrationWebhook.deleteMany({
      where: { integrationId: integration.id },
    });
  }
}
