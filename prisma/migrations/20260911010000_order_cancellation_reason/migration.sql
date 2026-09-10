-- Why an order was cancelled.
--
-- Admins can cancel an order, but nothing recorded the reason and nothing told
-- the buyer — the order simply changed state under them. Both columns are
-- nullable and every existing row keeps NULL, which reads as "not cancelled,
-- or cancelled before we recorded why".

ALTER TABLE "orders"
  ADD COLUMN "cancellationReason" TEXT,
  ADD COLUMN "cancelledAt" TIMESTAMP(3);
