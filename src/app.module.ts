import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_GUARD } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import * as Joi from 'joi';

// Infrastructure modules
import { DatabaseModule } from './database/database.module';
import { RedisModule } from './config/redis.module';
import { HealthModule } from './health/health.module';

// Feature modules
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { BuyersModule } from './modules/buyers/buyers.module';
import { SellersModule } from './modules/sellers/sellers.module';
import { ProductsModule } from './modules/products/products.module';
import { FeedsModule } from './modules/feeds/feeds.module';
import { CartModule } from './modules/cart/cart.module';
import { OrdersModule } from './modules/orders/orders.module';
import { WishlistModule } from './modules/wishlist/wishlist.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { AdminModule } from './modules/admin/admin.module';
import { StorageModule } from './modules/storage/storage.module';
import { SettlementsModule } from './modules/settlements/settlements.module';
import { ReviewsModule } from './modules/reviews/reviews.module';
import { TicketsModule } from './modules/tickets/tickets.module';
import { BlogModule } from './modules/blog/blog.module';
import { CategoriesModule } from './modules/categories/categories.module';
import { MigrationModule } from './modules/migration/migration.module';
import { VerificationModule } from './modules/verification/verification.module';
import { ReferralModule } from './modules/referrals/referral.module';
import { CustomOrdersModule } from './modules/custom-orders/custom-orders.module';
import { ChatbotModule } from './modules/chatbot/chatbot.module';
import { BrandsModule } from './modules/brands/brands.module';
import { BannersModule } from './modules/banners/banners.module';
import { HomepageSectionsModule } from './modules/homepage-sections/homepage-sections.module';
import { InstagramModule } from './modules/instagram/instagram.module';
import { IntegrationsModule } from './modules/integrations/integrations.module';
import { LocationsModule } from './modules/locations/locations.module';
import { MailModule } from './modules/mail/mail.module';
import { SeoModule } from './modules/seo/seo.module';
import { WebAnalyticsModule } from './modules/web-analytics/web-analytics.module';

@Module({
  imports: [
    // ─── Global config with Joi validation ────────────
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      validationSchema: Joi.object({
        PORT: Joi.number().default(3000),
        DATABASE_URL: Joi.string().required(),
        JWT_SECRET: Joi.string().required(),
        REDIS_URL: Joi.string().allow('').optional(),
        REDIS_HOST: Joi.string().default('localhost'),
        REDIS_PORT: Joi.number().default(6379),
        AWS_ACCESS_KEY: Joi.string().allow('').default(''),
        AWS_ACCESS_KEY_ID: Joi.string().allow('').default(''),
        AWS_SECRET_KEY: Joi.string().allow('').default(''),
        AWS_SECRET_ACCESS_KEY: Joi.string().allow('').default(''),
        AWS_ACCESS_SECRET_KEY: Joi.string().allow('').default(''),
        AWS_BUCKET: Joi.string().default('yukizi-images'),
        AWS_REGION: Joi.string().default('ap-south-1'),
        CORS_ORIGINS: Joi.string().default(
          'http://localhost:3000,http://localhost:3001,http://localhost:3002,http://localhost:3003,http://localhost:5173,https://yukizi-web-admin.vercel.app,https://yukizi-web-seller.vercel.app,https://yukizi-web-buyer.vercel.app,https://seller.yukizi.com,https://admin.yukizi.com,https://yukizi-api.onrender.com/api,https://yukizi-api.onrender.com,https://yukizi.in,https://www.yukizi.in,https://admin.yukizi.in,https://seller.yukizi.in,http://api.yukizi.in,api.yukizi.in',
        ),
        PLATFORM_COMMISSION_RATE: Joi.number().default(0.05),
        IDFY_ACCOUNT_ID: Joi.string().allow('').optional(),
        IDFY_API_KEY: Joi.string().allow('').optional(),
        IDFY_MOCK_MODE: Joi.string().allow('').optional(),
        GEMINI_API_KEY: Joi.string().allow('').optional(),
        COGNITO_USER_POOL_ID: Joi.string().allow('').optional(),
        COGNITO_CLIENT_ID: Joi.string().allow('').optional(),
        SMTP_USER: Joi.string().allow('').optional(),
        SMTP_APP_PASSWORD: Joi.string().allow('').optional(),
        MAIL_FROM_NAME: Joi.string().allow('').optional(),
        MAIL_REPLY_TO: Joi.string().allow('').optional(),

        // ─── Integrations (sales channels) ───────────
        // All optional: a provider whose credentials are absent is shown as
        // unavailable in the seller UI rather than breaking boot.
        // 32 bytes, hex or base64 — `openssl rand -hex 32`. Without it, no
        // authorization flow is allowed to start.
        INTEGRATIONS_ENCRYPTION_KEY: Joi.string().allow('').optional(),
        SELLER_APP_URL: Joi.string().allow('').optional(),
        API_PUBLIC_URL: Joi.string().allow('').optional(),
        SHOPIFY_CLIENT_ID: Joi.string().allow('').optional(),
        SHOPIFY_CLIENT_SECRET: Joi.string().allow('').optional(),
        SHOPIFY_REDIRECT_URI: Joi.string().allow('').optional(),
        AMAZON_LWA_CLIENT_ID: Joi.string().allow('').optional(),
        AMAZON_LWA_CLIENT_SECRET: Joi.string().allow('').optional(),
        AMAZON_SP_API_APP_ID: Joi.string().allow('').optional(),
        AMAZON_REDIRECT_URI: Joi.string().allow('').optional(),
        AMAZON_SP_API_APP_DRAFT: Joi.string().allow('').optional(),
      }),
      validationOptions: { abortEarly: true },
    }),

    // ─── Structured logging (Pino) ───────────────────
    LoggerModule.forRoot({
      pinoHttp: {
        transport:
          process.env.NODE_ENV !== 'production'
            ? {
                target: 'pino-pretty',
                options: { colorize: true, singleLine: true },
              }
            : undefined,
        autoLogging: true,
        serializers: {
          req: (req: any) => ({
            method: req.method,
            url: req.url,
          }),
          res: (res: any) => ({
            statusCode: res.statusCode,
          }),
        },
      },
    }),

    // ─── Rate limiting ───────────────────────────────
    // Generic per-IP backstop only. Sensitive routes (OTP/login, order
    // creation, payments) keep their own much tighter @Throttle overrides.
    // 100/min starved legitimate use: one open portal tab fans out enough
    // requests that a second tab (or a storefront build prerendering every
    // page) hits 429s that surface as phantom "not found" errors.
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60000, limit: 300 }],
    }),

    // ─── Scheduled jobs (Shiprocket status sync, etc.) ─
    ScheduleModule.forRoot(),

    // Infrastructure
    DatabaseModule,
    RedisModule,
    HealthModule,

    // Feature modules
    AuthModule,
    UsersModule,
    BuyersModule,
    SellersModule,
    ProductsModule,
    FeedsModule,
    CartModule,
    OrdersModule,
    WishlistModule,
    PaymentsModule,
    NotificationsModule,
    MailModule,
    SeoModule,
    WebAnalyticsModule,
    AdminModule,
    StorageModule,
    SettlementsModule,
    ReviewsModule,
    TicketsModule,
    BlogModule,
    CategoriesModule,
    MigrationModule,
    VerificationModule,
    ReferralModule,
    CustomOrdersModule,
    ChatbotModule,
    BrandsModule,
    BannersModule,
    HomepageSectionsModule,
    InstagramModule,
    LocationsModule,
    IntegrationsModule,
  ],
  providers: [
    // Apply throttler guard globally
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
