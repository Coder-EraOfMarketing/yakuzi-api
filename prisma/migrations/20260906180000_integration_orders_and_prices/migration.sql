-- Phase 4: channel order visibility and price synchronisation.
--
-- Additive only. The new table is deliberately NOT Yukizi's `orders`:
-- settlements are computed by querying `order_items`, so a channel sale
-- written there would make Yukizi owe the seller money for an order it never
-- processed. It also carries no customer PII — Yukizi does not need another
-- platform's customer data to show a seller their own sales.

-- AlterEnum
ALTER TYPE "SyncJobType" ADD VALUE 'ORDER_IMPORT';
ALTER TYPE "SyncJobType" ADD VALUE 'PRICE_PUSH';

-- AlterTable: what the channel currently charges, so a price difference can be
-- shown without re-querying. Nullable; nothing is overwritten on its strength.
ALTER TABLE "integration_product_mappings"
  ADD COLUMN "externalPrice" DECIMAL(12,2),
  ADD COLUMN "externalPriceAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "integration_external_orders" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "externalOrderId" TEXT NOT NULL,
    "orderNumber" TEXT,
    "placedAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT,
    "financialStatus" TEXT,
    "currency" TEXT,
    "totalAmount" DECIMAL(12,2) NOT NULL,
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "items" JSONB NOT NULL,
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_external_orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "integration_external_orders_sellerId_placedAt_idx" ON "integration_external_orders"("sellerId", "placedAt");
CREATE INDEX "integration_external_orders_integrationId_placedAt_idx" ON "integration_external_orders"("integrationId", "placedAt");
-- Re-importing an order updates it rather than duplicating it.
CREATE UNIQUE INDEX "integration_external_orders_integrationId_externalOrderId_key" ON "integration_external_orders"("integrationId", "externalOrderId");

-- AddForeignKey
ALTER TABLE "integration_external_orders" ADD CONSTRAINT "integration_external_orders_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "seller_integrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
