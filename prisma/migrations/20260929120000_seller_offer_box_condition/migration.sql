-- CreateEnum
CREATE TYPE "BoxCondition" AS ENUM ('WITH_BOX', 'WITHOUT_BOX');

-- AlterTable
-- Nullable on purpose. A listing written without an answer renders no tag,
-- rather than silently claiming WITH_BOX to a buyer. Required-ness lives in
-- the create DTO and the shared product form, not here.
ALTER TABLE "seller_offers" ADD COLUMN "boxCondition" "BoxCondition";

-- Backfill: every listing that exists today is recorded as shipping with its
-- box, so the storefront shows a complete set of tags immediately.
--
-- This is a deliberate, accepted claim rather than a neutral default: nobody
-- verified the packaging of these rows, so any listing that actually ships
-- boxless will display the opposite until its seller corrects it.
UPDATE "seller_offers" SET "boxCondition" = 'WITH_BOX' WHERE "boxCondition" IS NULL;
