import { Module } from '@nestjs/common';
import { ProductsModule } from '../products/products.module';
import { IntegrationEventsService } from './integration-events.service';
import { IntegrationImportService } from './integration-import.service';
import { IntegrationJobRunnerService } from './integration-job-runner.service';
import { IntegrationPushService } from './integration-push.service';
import { IntegrationReconciliationService } from './integration-reconciliation.service';
import { IntegrationWebhookRegistrationService } from './integration-webhook-registration.service';
import { IntegrationsController } from './integrations.controller';
import { IntegrationCallbacksController } from './integration-callbacks.controller';
import { IntegrationsService } from './integrations.service';
import { IntegrationOAuthService } from './integration-oauth.service';
import { IntegrationWebhooksService } from './integration-webhooks.service';
import { IntegrationHealthService } from './integration-health.service';
import { EncryptionService } from './encryption.service';
import { ShopifyProvider } from './providers/shopify.provider';
import { WooCommerceProvider } from './providers/woocommerce.provider';
import { AmazonProvider } from './providers/amazon.provider';

/**
 * External sales-channel integrations.
 *
 * PrismaService and ConfigService come from the app's global modules, so
 * nothing needs importing here — same as every other feature module.
 */
@Module({
  // ProductsModule exports InventoryService, which owns the DEFAULT-batch
  // convention for stock. Imported stock goes through that same path so it
  // behaves exactly like stock typed into the seller portal.
  imports: [ProductsModule],
  controllers: [IntegrationsController, IntegrationCallbacksController],
  providers: [
    IntegrationsService,
    IntegrationOAuthService,
    IntegrationWebhooksService,
    IntegrationHealthService,
    IntegrationImportService,
    IntegrationJobRunnerService,
    IntegrationPushService,
    IntegrationEventsService,
    IntegrationReconciliationService,
    IntegrationWebhookRegistrationService,
    EncryptionService,
    ShopifyProvider,
    WooCommerceProvider,
    AmazonProvider,
  ],
  exports: [IntegrationsService],
})
export class IntegrationsModule {}
