-- Issue #1470 — the PR-review job path writes its outcome to `pr_review_state`.
-- Postgres twin of the SQLite migration; see that file
-- (server/prisma/migrations/20261029001470_issue1470_pr_review_state_outcome)
-- for the full rationale. All nullable, no backfill.
--
-- Structural DDL is idempotent (#556), so the full history applies from empty.
--
-- Rollback (documentation):
--   ALTER TABLE "pr_review_state" DROP COLUMN "lastReviewUrl";
--   ALTER TABLE "pr_review_state" DROP COLUMN "lastSkipReason";
--   ALTER TABLE "pr_review_state" DROP COLUMN "lastStatus";

-- AlterTable
ALTER TABLE "pr_review_state" ADD COLUMN IF NOT EXISTS "lastStatus" TEXT;
ALTER TABLE "pr_review_state" ADD COLUMN IF NOT EXISTS "lastSkipReason" TEXT;
ALTER TABLE "pr_review_state" ADD COLUMN IF NOT EXISTS "lastReviewUrl" TEXT;
