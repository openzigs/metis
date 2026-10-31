-- Issue #1609 — per-project outcome of an impact run. Postgres twin of the
-- SQLite migration; see that file
-- (server/prisma/migrations/20261105001609_issue1609_impact_project_outcome)
-- for the full rationale. Nullable, not backfilled.
--
-- Structural DDL is idempotent (#556), so the full history applies from empty.
--
-- Rollback (documentation):
--   ALTER TABLE "impact_analysis_projects" DROP COLUMN "outcomeReason";
--   ALTER TABLE "impact_analysis_projects" DROP COLUMN "outcome";

-- AlterTable
ALTER TABLE "impact_analysis_projects" ADD COLUMN IF NOT EXISTS "outcome" TEXT;
ALTER TABLE "impact_analysis_projects" ADD COLUMN IF NOT EXISTS "outcomeReason" TEXT;
