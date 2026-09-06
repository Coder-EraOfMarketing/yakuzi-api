-- Phase 3 (inventory export) additions.
--
-- Writing a quantity back to a channel needs an identifier the read path did
-- not require:
--   * Shopify keys inventory on inventory_item_id, not the variant id.
--   * Amazon's Listings Items PATCH refuses an update without productType.
--
-- Both are captured during import so a push costs no extra API call. Nullable
-- and additive: existing mapping rows simply have no value until re-imported,
-- and the push path skips a row it cannot address rather than guessing.

ALTER TABLE "integration_product_mappings"
  ADD COLUMN "externalInventoryRef" TEXT,
  ADD COLUMN "externalProductType" TEXT;
