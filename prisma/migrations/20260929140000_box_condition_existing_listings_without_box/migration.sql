-- Corrects the backfill in 20260929120000_seller_offer_box_condition.
--
-- That migration recorded every listing that predated the feature as
-- WITH_BOX, so the catalogue would show a complete set of tags immediately.
-- The call has since been reversed: listings nobody has answered for should
-- read WITHOUT_BOX.
--
-- That is also the safer of the two claims. A buyer told "without box" who
-- receives one is not harmed; a buyer told "with box" who does not receive
-- one has been misled and will complain. Understating is recoverable,
-- overstating is not.
--
-- Scoped by createdAt, not by value alone. Every row this is meant to fix was
-- created before the original migration ran, and createdAt never changes -
-- so a listing created afterwards through the seller form, carrying a real
-- answer from a real person, is untouched no matter what that answer was.
-- updatedAt would NOT be a safe discriminator: the original backfill was raw
-- SQL and never bumped it, while unrelated admin actions (approve, disable)
-- do.
--
-- Verified immediately before writing this: 112 listings, all WITH_BOX, none
-- created or updated since the original migration finished at
-- 2026-09-29T03:46:21.785Z, and the newest listing dated 2026-09-27. So there
-- were no genuine seller answers to overwrite at authoring time, and the
-- clause below protects any that appear before this is deployed.
UPDATE "seller_offers"
   SET "boxCondition" = 'WITHOUT_BOX'
 WHERE "boxCondition" = 'WITH_BOX'
   AND "createdAt" < TIMESTAMP '2026-09-29 03:46:21.785';
