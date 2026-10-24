-- Issue #1470 — the PR-review job path writes its outcome to `pr_review_state`
-- so `/projects/:id/pulls` can list every automatic review and every skip.
--
--   lastStatus      reviewed | skipped | failed — the latest job's outcome
--   lastSkipReason  why it was skipped (no_linked_issue, budget_exceeded, …)
--   lastReviewUrl   the GitHub `html_url` of the last review posted
--
-- All nullable, no backfill: rows written before this change (there were none
-- in production, as nothing called the writer) read as "no status recorded".
--
-- Rollback (documentation):
--   ALTER TABLE "pr_review_state" DROP COLUMN "lastReviewUrl";
--   ALTER TABLE "pr_review_state" DROP COLUMN "lastSkipReason";
--   ALTER TABLE "pr_review_state" DROP COLUMN "lastStatus";

-- AlterTable
ALTER TABLE "pr_review_state" ADD COLUMN "lastStatus" TEXT;
ALTER TABLE "pr_review_state" ADD COLUMN "lastSkipReason" TEXT;
ALTER TABLE "pr_review_state" ADD COLUMN "lastReviewUrl" TEXT;
