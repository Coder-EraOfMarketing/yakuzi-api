import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger as PinoLogger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { json, urlencoded } from 'express';
import compression from 'compression';

async function bootstrap() {
  const logger = new Logger('Bootstrap'); // Refreshing backend to pick up DTO changes

  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
  });

  const configService = app.get(ConfigService);
  const corsOriginsRaw = configService.get<string>('CORS_ORIGINS', '');
  const allowedOriginsList = corsOriginsRaw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  // Top-level Express middleware to guarantee CORS headers & intercept OPTIONS preflight requests before any guards/pipes/filters
  app.use((req: any, res: any, next: any) => {
    const origin = req.headers.origin;

    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader(
        'Access-Control-Allow-Methods',
        'GET, HEAD, PUT, PATCH, POST, DELETE, OPTIONS',
      );
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Accept, Authorization, X-Requested-With, X-Visitor-Id, Origin, Access-Control-Allow-Origin, Access-Control-Allow-Headers, Access-Control-Allow-Methods',
      );
    }

    if (req.url === '/favicon.ico' || req.url === '/favicon.png') {
      return res.status(204).end();
    }

    if (req.method === 'OPTIONS') {
      // Without this browsers re-send the preflight about every 5 seconds,
      // which doubles the calls once the site talks to the API directly.
      res.setHeader('Access-Control-Max-Age', '7200');
      return res.status(204).end();
    }

    next();
  });



  // JSON responses leave uncompressed today (a 100-product listing is ~59 KB
  // on the wire); gzip cuts that ~85% for every client that accepts it.
  app.use(compression());

  // Increase payload size limit for base64 image/file attachments.
  // The verify hook keeps the raw bytes on the request: Razorpay signs the
  // exact body it sends, so the webhook must HMAC the raw payload - a
  // re-serialised JSON.parse round-trip would not verify.
  app.use(
    json({
      limit: '50mb',
      verify: (req: any, _res: any, buf: Buffer) => {
        req.rawBody = buf;
      },
    }),
  );
  app.use(urlencoded({ extended: true, limit: '50mb' }));

  // Use Pino structured logger
  app.useLogger(app.get(PinoLogger));

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // Global exception filter
  app.useGlobalFilters(new HttpExceptionFilter());

  app.enableCors({
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      if (!origin) return callback(null, true);
      const isAllowed =
        allowedOriginsList.includes(origin) ||
        /^https?:\/\/(?:[a-zA-Z0-9-]+\.)*yukizi\.(?:com|in)$/i.test(origin) ||
        /^https?:\/\/(?:[a-zA-Z0-9-]+\.)*dev\.yukizi\.com$/i.test(origin) ||
        /^https?:\/\/[a-zA-Z0-9-]+\.vercel\.app$/i.test(origin) ||
        /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(origin);
      callback(null, isAllowed);
    },
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    allowedHeaders: [
      'Content-Type',
      'Accept',
      'Authorization',
      'X-Requested-With',
      'X-Visitor-Id',
      'Origin',
      'Access-Control-Allow-Origin',
      'Access-Control-Allow-Headers',
      'Access-Control-Allow-Methods',
    ],
    credentials: true,
    preflightContinue: false,
    optionsSuccessStatus: 204,
  });



  // Global API prefix
  app.setGlobalPrefix('api');

  // Swagger documentation
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Yukizi API')
    .setDescription(
      'Yukizi B2B Marketplace — REST API documentation.\n\n' +
        '**Auth:** Phone OTP → JWT Bearer token.\n' +
        '**Roles:** BUYER, SELLER, ADMIN.\n' +
        'Attach the JWT token using the **Authorize** button.',
    )
    .setVersion('1.0.0')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      'JWT-auth',
    )
    .addTag('Auth', 'OTP login, token refresh, profile')
    .addTag('Buyers', 'Buyer onboarding & profile')
    .addTag('Sellers', 'Seller onboarding & profile')
    .addTag('Products', 'Product catalog CRUD & search')
    .addTag('Cart', 'Shopping cart management')
    .addTag('Orders', 'Order placement & tracking')
    .addTag('Payments', 'Manual payment recording & verification')
    .addTag('Storage', 'S3 file uploads')
    .addTag('Notifications', 'User notification feed')
    .addTag('Reviews', 'Product reviews & ratings')
    .addTag('Tickets', 'Support ticket system')
    .addTag('Settlements', 'Seller settlement & payouts')
    .addTag('Admin', 'Admin dashboard & user management')
    .addTag('Integrations', 'Seller sales-channel connections & inventory sync')
    .addTag('Health', 'System health checks')
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document, {
    swaggerOptions: {
      persistAuthorization: true,
      tagsSorter: 'alpha',
      operationsSorter: 'alpha',
    },
  });

  const port = configService.get<number>('PORT') || 3000;

  await app.listen(port, '0.0.0.0');
  logger.log(`🚀 Yukizi API Engine is active on port ${port} (/api)`);
  logger.log(`📚 Interactive Swagger API Documentation: http://localhost:${port}/api/docs`);
}
bootstrap();

