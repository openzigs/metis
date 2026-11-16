-- Issue #2270 (epic #2227) — the clarification dialog of an Impact Analysis
-- run or a portfolio check started on a document. Postgres twin of
-- server/prisma/migrations/20261202002270_issue2270_subject_clarification_dialogs;
-- see that file for the rationale. One new table, keyed on its subject and
-- cascading with it.
--
-- Structural DDL is idempotent (#556), so the full history applies from empty.
--
-- Rollback: server/prisma/postgres/rollbacks/20261202002270_issue2270_subject_clarification_dialogs.sql

-- CreateTable
CREATE TABLE IF NOT EXISTS "subject_clarification_dialogs" (
    "id" TEXT NOT NULL,
    "impactAnalysisId" TEXT,
    "portfolioAssessmentId" TEXT,
    "projectId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "requirements" TEXT NOT NULL,
    "state" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subject_clarification_dialogs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "subject_clarification_dialogs_impactAnalysisId_key" ON "subject_clarification_dialogs"("impactAnalysisId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "subject_clarification_dialogs_portfolioAssessmentId_key" ON "subject_clarification_dialogs"("portfolioAssessmentId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "subject_clarification_dialogs_projectId_idx" ON "subject_clarification_dialogs"("projectId");

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subject_clarification_dialogs_impactAnalysisId_fkey') THEN
    EXECUTE 'ALTER TABLE "subject_clarification_dialogs" ADD CONSTRAINT "subject_clarification_dialogs_impactAnalysisId_fkey" FOREIGN KEY ("impactAnalysisId") REFERENCES "impact_analyses"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subject_clarification_dialogs_portfolioAssessmentId_fkey') THEN
    EXECUTE 'ALTER TABLE "subject_clarification_dialogs" ADD CONSTRAINT "subject_clarification_dialogs_portfolioAssessmentId_fkey" FOREIGN KEY ("portfolioAssessmentId") REFERENCES "portfolio_assessments"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END
$idem$;
