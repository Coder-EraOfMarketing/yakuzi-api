import { Module } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { MerchantConfigService } from './merchant.config';
import { MerchantAuthService } from './merchant.auth';
import { MerchantClient } from './merchant.client';
import { MerchantSyncService } from './merchant-sync.service';
import { MerchantController } from './merchant.controller';
import { MerchantCron } from './merchant.cron';

/**
 * Google Merchant Center integration: pushes the catalogue to Merchant Center
 * via the Merchant API, on a daily schedule and on demand from the admin
 * panel. Authenticates with an explicit service-account key, or with the GCP
 * VM's own attached service account when no key is set. Self-contained —
 * depends only on Prisma.
 */
@Module({
  controllers: [MerchantController],
  providers: [
    PrismaService,
    MerchantAuthService,
    MerchantConfigService,
    MerchantClient,
    MerchantSyncService,
    MerchantCron,
  ],
  exports: [MerchantSyncService],
})
export class MerchantModule {}
