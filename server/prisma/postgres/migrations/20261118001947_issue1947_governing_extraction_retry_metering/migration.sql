-- Issue #1947 (epic #1866) — governing rule extraction can be retried, and its
-- model calls are metered (Postgres twin of
-- server/prisma/migrations/20261118001947_issue1947_governing_extraction_retry_metering;
-- see that file for the rationale). Nothing backfilled. Idempotent (#556).
--
-- Rollback: server/prisma/postgres/rollbacks/20261118001947_issue1947_governing_extraction_retry_metering.sql

ALTER TABLE "governing_document_revisions" ADD COLUMN IF NOT EXISTS "extractionStartedAt" TIMESTAMP(3);

ALTER TABLE "token_usages" ADD COLUMN IF NOT EXISTS "workspaceId" TEXT;
ALTER TABLE "token_usages" ALTER COLUMN "projectId" DROP NOT NULL;

CREATE INDEX IF NOT EXISTS "token_usages_workspaceId_createdAt_idx" ON "token_usages"("workspaceId", "createdAt");
