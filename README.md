# yakuzi API

B2B Pharmaceutical Marketplace — NestJS REST API backend.

## Tech Stack

| Layer         | Technology                              |
| ------------- | --------------------------------------- |
| Runtime       | Node.js 20+                             |
| Framework     | NestJS 11                               |
| Language      | TypeScript 5 (ESM, `nodenext`)          |
| Database      | PostgreSQL (Neon cloud)                 |
| ORM           | Prisma 6                                |
| Cache / OTP   | Redis (ioredis)                         |
| Auth          | Phone OTP → JWT (access + refresh)      |
| File Storage  | AWS S3 (`@aws-sdk/client-s3`)           |
| API Docs      | Swagger / OpenAPI 3 (`@nestjs/swagger`) |
| Logging       | Pino (structured JSON, `nestjs-pino`)   |
| Rate Limiting | `@nestjs/throttler`                     |

## Prerequisites

- **Node.js** ≥ 20
- **Redis** running locally (default `localhost:6379`)
- **PostgreSQL** (or Neon cloud connection string)

## Getting Started

```bash
# 1. Install dependencies
npm install

# 2. Copy env template and fill values
cp .env.example .env

# 3. Run Prisma migrations
npx prisma migrate deploy

# 4. Generate Prisma client
npx prisma generate

# 5. Seed database (categories, sub-categories, test users)
npx prisma db seed

# 6. Start dev server
npm run start:dev
```

The server starts on **http://localhost:3000**.

### Production Database Local Access (Private Subnet)

Because the production RDS database is in a private subnet with no public internet access, you cannot connect to it directly from your local machine. Use one of the following methods to tunnel your connection:

- **Option 1: Kubernetes Port Forwarding (Recommended)**
  Tunnel through a running backend pod:

  ```bash
  aws eks update-kubeconfig --name yukizi-production-eks --region ap-south-1
  kubectl port-forward deployment/backend 5432:5432 -n yukizi
  ```

  Then connect your local environment using `localhost:5432`.

- **Option 2: AWS SSM Session Manager**
  Establish a port forward via SSM:
  ```bash
  aws ssm start-session \
    --target <ec2-instance-id> \
    --document-name AWS-StartPortForwardingSessionToRemoteHost \
    --parameters '{"host":["yukizi-production-postgres.c708m08w68tr.ap-south-1.rds.amazonaws.com"],"portNumber":["5432"],"localPortNumber":["5432"]}'
  ```

## Environment Variables

| Variable                   | Required | Default                     | Description                     |
| -------------------------- | -------- | --------------------------- | ------------------------------- |
| `DATABASE_URL`             | **Yes**  | —                           | PostgreSQL connection string    |
| `JWT_SECRET`               | **Yes**  | —                           | Secret for JWT signing          |
| `REDIS_HOST`               | No       | `localhost`                 | Redis host                      |
| `REDIS_PORT`               | No       | `6379`                      | Redis port                      |
| `AWS_ACCESS_KEY`           | No       | —                           | S3 access key                   |
| `AWS_SECRET_KEY`           | No       | —                           | S3 secret key                   |
| `AWS_REGION`               | No       | `ap-south-1`                | AWS region                      |
| `AWS_BUCKET`               | No       | `yukizi-images`          | S3 bucket name                  |
| `CORS_ORIGINS`             | No       | `http://localhost:3000,...` | Comma-separated allowed origins |
| `PLATFORM_COMMISSION_RATE` | No       | `5`                         | Commission % on orders          |
| `STOREFRONT_URL`           | No       | `https://yukizi.com`        | Buyer app to ping on SEO saves  |
| `STOREFRONT_REVALIDATE_SECRET` | No   | —                           | Shared with the buyer app's env of the same name. Set both and an admin's SEO edit appears at once; unset, the storefront just refreshes on its 5-minute timer |

## API Documentation

### Swagger UI

Open **http://localhost:3000/api/docs** after starting the server.

- Click **Authorize** and paste a JWT token to test authenticated endpoints.
- All endpoints are documented with request/response schemas.

### Postman Collection

Import `docs/yukizi-api.postman_collection.json` into Postman. The collection includes:

- All endpoints organized into 18 folders (including Categories & Migration)
- Pre-configured auth tokens as collection variables
- Auto-save of `accessToken`, `productId`, `orderId`, `categoryId`, etc. via test scripts
- Example request bodies for every POST/PATCH endpoint

## Modules

| Module                 | Endpoints | Description                                                   |
| ---------------------- | --------- | ------------------------------------------------------------- |
| **Auth**               | 4         | Phone OTP send/verify, JWT refresh, get current user          |
| **Buyers**             | 3         | Create/get/update buyer profile (KYC)                         |
| **Sellers**            | 3         | Create/get/update seller profile (KYC)                        |
| **Categories (Admin)** | 12        | Category & subcategory CRUD, bulk seed, name→ID lookup maps   |
| **Products**           | 8         | CRUD + search, categories, seller's own products, bulk create |
| **Cart**               | 5         | Add/get/update/remove items, clear cart                       |
| **Orders**             | 5         | Checkout from cart, list orders, update status                |
| **Payments**           | 5         | Record payment, upload proof, admin confirm/reject            |
| **Storage**            | 3         | S3 file uploads (product images, payment proofs, KYC docs)    |
| **Notifications**      | 2         | List & mark-read (auto-created on order/payment events)       |
| **Reviews**            | 2         | Buyer product reviews                                         |
| **Tickets**            | 3         | Support ticket creation & messaging                           |
| **Settlements**        | 5         | Seller payout tracking, admin mark-paid                       |
| **Blog (Admin)**       | 15        | Blog posts CRUD, publish/unpublish, authors, categories       |
| **Blog (Public)**      | 6         | Published posts, trending, by tag/slug, view count, sitemap   |
| **Admin**              | 4         | Dashboard stats, user approval/rejection                      |
| **Health**             | 1         | DB + Redis health check                                       |

## Test Credentials

| Role   | Phone        | Notes                |
| ------ | ------------ | -------------------- |
| Buyer  | `7777777777` | Pre-seeded, approved |
| Seller | `8888888888` | Pre-seeded, approved |
| Admin  | `9999999999` | Pre-seeded           |

**OTP in development:** logged to console. Retrieve from Redis:

```bash
redis-cli GET otp:7777777777
```

## Auth Flow

1. `POST /api/auth/send-otp` → `{ "phone": "7777777777" }`
2. Retrieve OTP from Redis (dev) or SMS (production)
3. `POST /api/auth/verify-otp` → `{ "phone": "7777777777", "otp": "123456" }`
4. Response includes `accessToken`, `refreshToken`, `user`, `isNewUser`
5. Use `Authorization: Bearer <accessToken>` for protected endpoints

## Project Structure

```
src/
├── main.ts                          # Bootstrap (Swagger, Pino, CORS, filters)
├── app.module.ts                    # Root module (Joi env validation, throttle, logging)
├── common/
│   ├── decorators/                  # @Roles(), @CurrentUser()
│   ├── filters/                     # Global exception filter
│   └── guards/                      # JwtAuthGuard, RolesGuard
├── config/
│   ├── redis.config.ts              # Redis client factory
│   └── redis.module.ts              # Global Redis module
├── database/
│   └── prisma.service.ts            # Prisma client lifecycle
├── health/                          # Health check (DB + Redis)
└── modules/
    ├── auth/                        # OTP, JWT, refresh tokens
    ├── users/                       # User model (empty controller)
    ├── buyers/                      # Buyer profile & KYC
    ├── sellers/                     # Seller profile & KYC
    ├── categories/                  # Admin category/subcategory CRUD + migration maps
    ├── products/                    # Product catalog (+ bulk create, discount engine)
    ├── cart/                        # Shopping cart
    ├── orders/                      # Order management
    ├── payments/                    # Manual payment recording
    ├── storage/                     # S3 file uploads
    ├── notifications/               # In-app notifications
    ├── reviews/                     # Product reviews
    ├── tickets/                     # Support tickets
    ├── settlements/                 # Seller payouts
    ├── admin/                       # Admin dashboard & actions
    └── blog/                        # SEO-optimized blog CMS
prisma/
├── schema.prisma                    # 26 models, 9 enums
├── seed.ts                          # Categories + test users
└── migrations/                      # Database migrations
```

## Scripts

```bash
npm run start:dev     # Development with hot reload
npm run build         # Production build
npm run start:prod    # Start from dist/
npx prisma studio     # Visual database browser
npx prisma migrate dev  # Create new migration
```

## Blog System (SEO-Optimized CMS)

The blog module provides a full CMS for creating SEO-optimized content.

### Admin APIs (`/api/admin/blogs` — requires ADMIN role)

| Method   | Route                         | Description                                                   |
| -------- | ----------------------------- | ------------------------------------------------------------- |
| `POST`   | `/admin/blogs`                | Create blog post (auto-slug, reading time, HTML sanitization) |
| `GET`    | `/admin/blogs`                | List all posts (pagination, filter by status/category/search) |
| `GET`    | `/admin/blogs/:id`            | Get post by ID                                                |
| `PUT`    | `/admin/blogs/:id`            | Update post                                                   |
| `PATCH`  | `/admin/blogs/:id/status`     | Publish / unpublish                                           |
| `DELETE` | `/admin/blogs/:id`            | Delete post                                                   |
| `POST`   | `/admin/blogs/authors`        | Create author                                                 |
| `GET`    | `/admin/blogs/authors`        | List authors                                                  |
| `GET`    | `/admin/blogs/authors/:id`    | Get author                                                    |
| `PUT`    | `/admin/blogs/authors/:id`    | Update author                                                 |
| `DELETE` | `/admin/blogs/authors/:id`    | Delete author                                                 |
| `POST`   | `/admin/blogs/categories`     | Create category                                               |
| `GET`    | `/admin/blogs/categories`     | List categories                                               |
| `PUT`    | `/admin/blogs/categories/:id` | Update category                                               |
| `DELETE` | `/admin/blogs/categories/:id` | Delete category                                               |

### Public APIs (`/api/blogs` — no auth)

| Method | Route               | Description                                       |
| ------ | ------------------- | ------------------------------------------------- |
| `GET`  | `/blogs`            | Published posts (pagination, category/tag/search) |
| `GET`  | `/blogs/trending`   | Trending posts by views                           |
| `GET`  | `/blogs/categories` | All blog categories                               |
| `GET`  | `/blogs/tag/:tag`   | Posts by tag                                      |
| `GET`  | `/blogs/:slug`      | Single post by slug + JSON-LD structured data     |
| `POST` | `/blogs/:slug/view` | Increment view count                              |
| `GET`  | `/sitemap.xml`      | Auto-generated XML sitemap                        |

### Key Features

- **SEO**: Slug-based URLs, meta fields (title, description, keywords, canonical, OG image), JSON-LD structured data (schema.org `BlogPosting`)
- **Sitemap**: Auto-generated `sitemap.xml` from published posts
- **XSS Prevention**: `sanitize-html` sanitizes all content (HTML & Editor.js JSON blocks)
- **Caching**: Redis caching on public endpoints (5 min posts, 2 min lists) with automatic invalidation
- **Reading Time**: Auto-calculated (`words / 200`)
- **Content Format**: Supports Editor.js JSON or HTML/Markdown

## Categories & Migration System (Data Migration Toolkit)

The categories module and enhanced products module provide a complete toolkit for migrating data from legacy systems (e.g., MongoDB) into the new PostgreSQL backend.

### Admin Category APIs (`/api/admin` — requires ADMIN role)

| Method   | Route                       | Description                                                |
| -------- | --------------------------- | ---------------------------------------------------------- |
| `POST`   | `/admin/categories`         | Create a category (auto-generates slug)                    |
| `GET`    | `/admin/categories`         | List all categories with subcategories                     |
| `GET`    | `/admin/categories/map`     | Get category `{ name → UUID }` lookup map                  |
| `PATCH`  | `/admin/categories/:id`     | Update a category                                          |
| `DELETE` | `/admin/categories/:id`     | Delete a category                                          |
| `POST`   | `/admin/categories/bulk`    | Bulk-create categories from array                          |
| `POST`   | `/admin/subcategories`      | Create a subcategory                                       |
| `GET`    | `/admin/subcategories`      | List subcategories (filter by `categoryId`)                |
| `GET`    | `/admin/subcategories/map`  | Get subcategory `{ "Category::SubCat" → UUID }` lookup map |
| `PATCH`  | `/admin/subcategories/:id`  | Update a subcategory                                       |
| `DELETE` | `/admin/subcategories/:id`  | Delete a subcategory                                       |
| `POST`   | `/admin/subcategories/bulk` | Bulk-create subcategories from array                       |

### Product Bulk Create (`/api/products/bulk` — requires SELLER role)

| Method | Route            | Description                                       |
| ------ | ---------------- | ------------------------------------------------- |
| `POST` | `/products/bulk` | Bulk-create products with per-item error handling |

### Migration & Discount Features

- **Idempotent creation**: Products with an `externalId` (legacy MongoDB ObjectId) are upserted — re-running a migration script won't create duplicates
- **Slug-based dedup**: If `externalId` isn't provided, the auto-generated `slug` is used as a secondary dedup key
- **Migration mode**: Set `isMigration: true` to relax non-critical validations (e.g., image URL format) during bulk import
- **Product images**: Supply an array of `images` URLs on create/update — stored in `ProductImage` table
- **Discount engine**: 5 discount types stored as `discountType` enum + flexible `discountMeta` JSON:
  - `PTR_DISCOUNT` — Price-to-retailer discount (e.g., `{ "ptrPercent": 15 }`)
  - `SAME_PRODUCT_BONUS` — Buy X get Y free (e.g., `{ "buy": 10, "get": 2 }`)
  - `PTR_PLUS_SAME_PRODUCT_BONUS` — Combined PTR + bonus
  - `DIFFERENT_PRODUCT_BONUS` — Buy product A, get product B free
  - `PTR_PLUS_DIFFERENT_PRODUCT_BONUS` — Combined PTR + different product bonus
- **Data normalization**: Strings are trimmed, slugs are lowercased, `externalId` is trimmed on ingest
- **Bulk results**: Returns `{ success, failed, errors[], created[] }` with per-item error details

### Typical Migration Workflow

```bash
# 1. Seed categories & subcategories
curl -X POST /api/admin/categories/bulk \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"categories": [{"name": "Medicines"}, {"name": "Devices"}]}'

# 2. Get lookup maps
CAT_MAP=$(curl /api/admin/categories/map -H "Authorization: Bearer $ADMIN_TOKEN")
SUB_MAP=$(curl /api/admin/subcategories/map -H "Authorization: Bearer $ADMIN_TOKEN")

# 3. Bulk-create products (idempotent — safe to re-run)
curl -X POST /api/products/bulk \
  -H "Authorization: Bearer $SELLER_TOKEN" \
  -d '{"products": [{"name": "Paracetamol 500mg", "externalId": "507f1f77bcf86cd799439011", "isMigration": true, ...}]}'
```

## Rate Limiting

- **Global:** 20 requests per 60 seconds per IP
- **Sensitive routes** (5 per 60s): `send-otp`, `verify-otp`, checkout, create payment, confirm payment

## Infrastructure

- **Structured logging** via Pino — JSON in production, pretty-print in development
- **Global exception filter** catches all errors with consistent `{ statusCode, message, error, timestamp, path }` shape
- **CORS** configurable via `CORS_ORIGINS` env var (comma-separated)
- **Env validation** via Joi — server won't start with missing required vars

## License

Private — Elevante Labs
