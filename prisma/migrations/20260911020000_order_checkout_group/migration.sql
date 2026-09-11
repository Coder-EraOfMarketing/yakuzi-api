-- One id shared by every order a single checkout produced, so the payment for
-- a multi-seller cart can be taken and confirmed for the whole basket.
--
-- Additive and nullable: existing orders keep NULL and the payment code falls
-- back to the previous "same buyer, within five seconds" rule for them, so
-- nothing already in flight changes behaviour.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "checkoutGroupId" TEXT;

CREATE INDEX IF NOT EXISTS "orders_checkoutGroupId_idx" ON "orders"("checkoutGroupId");
