-- Issue #953 / #962 — a live Spec Kit issue export claims each task (an
-- `issueNumber` 0 row) before calling GitHub. These columns say when, and which
-- run holds it, so a claim left by a run that died, or kept after an ambiguous
-- GitHub failure (network error, 5xx, malformed 2xx), is told apart from one in
-- progress and reconciled against the target repository instead of blocking
-- the feature forever or being filed twice.
--
-- Both nullable, no default, no backfill: a claim written before this migration
-- has `claimedAt` NULL and no owning run, so it is treated as abandoned and
-- reconciled on the next export. An exported row (`issueNumber` > 0) never
-- reads them. Metadata-only on Postgres.
--
-- Rollback (documentation):
--   ALTER TABLE "spec_kit_task_exports" DROP COLUMN "claimRunId";
--   ALTER TABLE "spec_kit_task_exports" DROP COLUMN "claimedAt";
ALTER TABLE "spec_kit_task_exports" ADD COLUMN IF NOT EXISTS "claimedAt" TIMESTAMP(3);
ALTER TABLE "spec_kit_task_exports" ADD COLUMN IF NOT EXISTS "claimRunId" TEXT;
