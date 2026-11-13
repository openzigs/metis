-- Issue #2345 (epic #2328) — impact analysis and the portfolio check launched
-- from a change request (Postgres twin of
-- server/prisma/migrations/20261126002345_issue2345_change_request_checks; see
-- that file for the rationale). Nothing backfilled. Idempotent (#556).
--
-- Rollback: server/prisma/postgres/rollbacks/20261126002345_issue2345_change_request_checks.sql

ALTER TABLE "impact_analyses" ADD COLUMN IF NOT EXISTS "sourceAnalysisId" TEXT;
ALTER TABLE "portfolio_assessments" ADD COLUMN IF NOT EXISTS "sourceAnalysisId" TEXT;
ALTER TABLE "portfolio_assessments" ADD COLUMN IF NOT EXISTS "preApproval" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "impact_analyses_sourceAnalysisId_idx" ON "impact_analyses"("sourceAnalysisId");
CREATE INDEX IF NOT EXISTS "portfolio_assessments_sourceAnalysisId_idx" ON "portfolio_assessments"("sourceAnalysisId");
