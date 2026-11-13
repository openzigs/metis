-- Issue #2345 (epic #2328) — impact analysis and the portfolio check are
-- launched from a change request (an analysis run), pre-filled with its
-- requirements, and the change request shows their results.
--
-- 1. "impact_analyses"."sourceAnalysisId" (nullable TEXT, no FK, like
--    "requirementIds"): the change request the run was started from, so the
--    run outlives a deleted change request. Null for every existing row.
-- 2. "portfolio_assessments"."sourceAnalysisId" (nullable TEXT, no FK, like
--    "sourceDocumentId"): the change request whose requirements were checked.
-- 3. "portfolio_assessments"."preApproval" (BOOLEAN NOT NULL DEFAULT false):
--    true when a requirement checked was not approved when the check started.
--    Every existing row reads false: nothing recorded it before #2345.
-- Plus an index on each "sourceAnalysisId": a change request lists its own.
--
-- Rollback: server/prisma/rollbacks/20261126002345_issue2345_change_request_checks.sql
-- (exercised by server/tests/change-request-checks-migration-2345.sqlite.test.ts).

-- AlterTable
ALTER TABLE "impact_analyses" ADD COLUMN "sourceAnalysisId" TEXT;
ALTER TABLE "portfolio_assessments" ADD COLUMN "sourceAnalysisId" TEXT;
ALTER TABLE "portfolio_assessments" ADD COLUMN "preApproval" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "impact_analyses_sourceAnalysisId_idx" ON "impact_analyses"("sourceAnalysisId");
CREATE INDEX "portfolio_assessments_sourceAnalysisId_idx" ON "portfolio_assessments"("sourceAnalysisId");
