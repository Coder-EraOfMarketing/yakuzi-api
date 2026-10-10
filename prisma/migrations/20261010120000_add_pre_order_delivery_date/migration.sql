-- AlterTable
-- Nullable, and the nullability IS the feature: a non-null value means this
-- listing is sold as a pre-order, and the date is what the seller has
-- promised. A separate boolean could drift out of step with the date, so
-- there isn't one.
ALTER TABLE "seller_offers" ADD COLUMN "preOrderDeliveryDate" TIMESTAMP(3);

-- AlterTable
-- The promise as it stood when the order was placed. Snapshotted rather than
-- read back from the listing, so a seller moving their date later cannot
-- rewrite what an existing buyer was told. Same rule as orders.fulfillmentMode.
ALTER TABLE "order_items" ADD COLUMN "preOrderDeliveryDate" TIMESTAMP(3);
