import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { ImageRenameService } from './image-rename.service';
import { DatabaseModule } from '../../database/database.module';
import { SeoController } from './seo.controller';
import { AdminSeoController } from './seo-admin.controller';
import { SeoService } from './seo.service';
import { SeoRedirectsService } from './seo-redirects.service';
import { SeoKeywordsService } from './seo-keywords.service';
import { SeoNotFoundService } from './seo-not-found.service';
import { StorefrontRevalidationService } from './storefront-revalidation.service';

@Module({
  imports: [DatabaseModule, StorageModule],
  controllers: [SeoController, AdminSeoController],
  providers: [
    SeoService,
    SeoRedirectsService,
    SeoKeywordsService,
    SeoNotFoundService,
    ImageRenameService,
    StorefrontRevalidationService,
  ],
  exports: [SeoService],
})
export class SeoModule {}
