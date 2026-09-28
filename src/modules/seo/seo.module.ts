import { Module } from '@nestjs/common';
import { ChatbotModule } from '../chatbot/chatbot.module';
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
  // ChatbotModule for the AI-summary drafting endpoint: it owns the only
  // Gemini path in this service (the Python sidecar), and re-implementing a
  // second one here would be a second key, a second timeout and a second set
  // of failure modes to keep in step.
  imports: [DatabaseModule, StorageModule, ChatbotModule],
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
