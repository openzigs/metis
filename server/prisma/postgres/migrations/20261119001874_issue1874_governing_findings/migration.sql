-- Issue #1874 (epic #1866) — cited governing findings, one per (analysis,
-- requirement, governing rule). Postgres twin of
-- server/prisma/migrations/20261119001874_issue1874_governing_findings; see that
-- file for the rationale. One new table, cascading with the analysis.
--
-- Structural DDL is idempotent (#556), so the full history applies from empty.
--
-- Rollback: server/prisma/postgres/rollbacks/20261119001874_issue1874_governing_findings.sql

-- CreateTable
CREATE TABLE IF NOT EXISTS "governing_findings" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "revisionLabel" TEXT NOT NULL,
    "documentTitle" TEXT NOT NULL,
    "controlId" TEXT NOT NULL,
    "clauseRef" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reasoning" TEXT NOT NULL,
    "clauseStart" INTEGER,
    "clauseEnd" INTEGER,
    "clauseExcerpt" TEXT,
    "citationDropped" BOOLEAN NOT NULL DEFAULT false,
    "modelStatus" TEXT,
    "businessQuestion" TEXT,
    "decision" TEXT,
    "decisionNote" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "governing_findings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "governing_findings_analysisId_status_idx" ON "governing_findings"("analysisId", "status");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "governing_findings_analysisId_requirementId_ruleId_key" ON "governing_findings"("analysisId", "requirementId", "ruleId");

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'governing_findings_analysisId_fkey') THEN
    EXECUTE 'ALTER TABLE "governing_findings" ADD CONSTRAINT "governing_findings_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "analyses"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END
$idem$;
