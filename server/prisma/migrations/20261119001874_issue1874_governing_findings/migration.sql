-- Issue #1874 (epic #1866) — cited governing findings: one row per
-- (analysis, requirement, governing rule), Compliant | Gap | Needs BA input,
-- cited to the clause of the revision it was checked against, with the BA's
-- accept/reject decision.
--
--   governing_findings  scoped by `analysisId` (cascades with the analysis).
--                   The rule's revision, label, document title, control id and
--                   clause are copied onto the row, so a later revision of the
--                   policy never rewrites what a finding cited. No foreign key
--                   to the rule or the revision (a deleted rule leaves its
--                   findings) nor to `users` (the decider outlives the account).
--
-- One new, empty table.
--
-- Rollback: server/prisma/rollbacks/20261119001874_issue1874_governing_findings.sql
-- (exercised by server/tests/governing-findings-migration-1874.sqlite.test.ts).

-- CreateTable
CREATE TABLE "governing_findings" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "decidedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "governing_findings_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "analyses" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "governing_findings_analysisId_status_idx" ON "governing_findings"("analysisId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "governing_findings_analysisId_requirementId_ruleId_key" ON "governing_findings"("analysisId", "requirementId", "ruleId");
