-- AlterTable
-- The cheapest final customer payable across a product's live offers: the
-- number the grid card prints. Price lives on seller_offers, so the master had
-- nothing sortable on it — "Sort by: Price, Low to High" ran
-- `ORDER BY catalog_products.mrp`, which is NULL on nearly every row, so asc
-- and desc returned byte-identical pages. Sorting has to happen in SQL for
-- pagination to be correct, which means the price has to exist as a column
-- here.
--
-- Nullable on purpose: NULL means nobody is selling this product right now,
-- which is a different fact from "it costs 0". The query orders NULLs last in
-- both directions so an unsold product never heads the list.
ALTER TABLE "catalog_products" ADD COLUMN "lowestOfferPrice" DECIMAL(10,2);

-- CreateIndex
-- This is the sort key of the main browse query, so it gets an index.
CREATE INDEX "catalog_products_lowestOfferPrice_idx" ON "catalog_products"("lowestOfferPrice");

-- Backfill from the offers that already exist, so the sort is correct on the
-- day this ships rather than only for products somebody happens to edit later.
--
-- An offer reaches its master by TWO routes: seller_offers."catalogProductId"
-- directly, or seller_offers."variantId" -> product_variants."catalogProductId".
-- Following only one of them silently halves the offer set — the same mistake
-- that previously produced a wrong product photo on orders, a 0% commission
-- and a flat-5% settlement. The UNION ALL below walks both.
--
-- Only genuinely-for-sale offers count: "isActive" = true AND "deletedAt" IS
-- NULL. "finalCustomerPayable" is the computed number the card shows, with
-- "mrp" as the fallback for an offer whose payable has never been recomputed —
-- which is exactly what the grid mapper falls back to.
WITH live_offers AS (
  SELECT
    o."catalogProductId" AS catalog_product_id,
    COALESCE(o."finalCustomerPayable", o."mrp") AS price
  FROM "seller_offers" o
  WHERE o."isActive" = true
    AND o."deletedAt" IS NULL
    AND o."catalogProductId" IS NOT NULL

  UNION ALL

  SELECT
    v."catalogProductId" AS catalog_product_id,
    COALESCE(o."finalCustomerPayable", o."mrp") AS price
  FROM "seller_offers" o
  JOIN "product_variants" v ON v."id" = o."variantId"
  WHERE o."isActive" = true
    AND o."deletedAt" IS NULL
),
lowest AS (
  SELECT catalog_product_id, MIN(price) AS lowest_price
  FROM live_offers
  WHERE price IS NOT NULL
  GROUP BY catalog_product_id
)
UPDATE "catalog_products" p
SET "lowestOfferPrice" = l.lowest_price
FROM lowest l
WHERE l.catalog_product_id = p."id";
