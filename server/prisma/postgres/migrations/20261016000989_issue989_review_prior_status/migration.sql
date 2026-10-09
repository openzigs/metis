-- Issue #989 — submitting a review of requirements used to reset every one of
-- them to draft, and a withdraw (or close) never gave the approval back. The
-- requirement's reviewStatus is now captured on the review item at submit, so a
-- withdraw or a pre-verdict close can restore it. Nullable, no default, no
-- backfill: a review submitted before this migration has no capture and a
-- withdraw leaves its requirements as they are. Metadata-only on Postgres.
--
-- Rollback (documentation):
--   ALTER TABLE "review_request_items" DROP COLUMN "priorReviewStatus";
ALTER TABLE "review_request_items" ADD COLUMN IF NOT EXISTS "priorReviewStatus" TEXT;
