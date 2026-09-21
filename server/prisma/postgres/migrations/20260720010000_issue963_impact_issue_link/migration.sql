-- Issue #963 (Epic #960) — allow IssueLink to reference a whole ImpactAnalysis
-- RUN (one published external issue per run), alongside the existing scanner
-- ScanFinding / analysis Finding references (Postgres mirror).
--
-- See the SQLite migration of the same name for the full rationale. All DDL is
-- idempotent (`IF NOT EXISTS`; the FK wrapped in a pg_constraint existence
-- DO-block) so the full migration history replays cleanly over the cumulative
-- `00000000000000_init` baseline on a fresh Postgres (issue #556 guard).

-- AlterTable
ALTER TABLE "scanner_issue_links" ADD COLUMN IF NOT EXISTS "impactAnalysisId" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "scanner_issue_links_impactAnalysisId_idx" ON "scanner_issue_links"("impactAnalysisId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "scanner_issue_links_impactAnalysisId_provider_key" ON "scanner_issue_links"("impactAnalysisId", "provider");

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scanner_issue_links_impactAnalysisId_fkey') THEN
    EXECUTE 'ALTER TABLE "scanner_issue_links" ADD CONSTRAINT "scanner_issue_links_impactAnalysisId_fkey" FOREIGN KEY ("impactAnalysisId") REFERENCES "impact_analyses"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END
$idem$;
