-- Server-backed wishlist.
--
-- Until now the wishlist lived only in the browser's localStorage: it did not
-- follow a buyer to another device, did not survive clearing the browser, and
-- every logged-in read fired a 404 at a route that never existed.
--
-- Additive only. Nothing reads or writes this table yet — the storefront is
-- rewired separately — so applying this migration changes no behaviour.
--
-- productId is deliberately NOT a foreign key. The storefront saves a
-- SellerOffer id, and a listing that is delisted or replaced must not cascade
-- somebody's saved list away with it. The id is resolved to a product on read,
-- and an id that no longer resolves is simply skipped.

CREATE TABLE "wishlist_items" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wishlist_items_pkey" PRIMARY KEY ("id")
);

-- One row per buyer per product: saving the same item twice is a no-op, and
-- the storefront's "remove" targets the pair rather than a row id.
CREATE UNIQUE INDEX "wishlist_items_userId_productId_key" ON "wishlist_items"("userId", "productId");

CREATE INDEX "wishlist_items_userId_idx" ON "wishlist_items"("userId");

ALTER TABLE "wishlist_items"
  ADD CONSTRAINT "wishlist_items_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
