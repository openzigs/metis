-- Issue #2270 (epic #2227) — the clarification dialog of an Impact Analysis
-- run or a portfolio check started on a document.
--
--   subject_clarification_dialogs  one row per impact run or portfolio check
--                   whose document the reader read: the requirements it read
--                   (each with its paragraph and its GtWR flags), and the
--                   dialog's state once the analyst asks the questions. Keyed
--                   on its subject, exactly one of `impactAnalysisId` and
--                   `portfolioAssessmentId` (each unique), because neither has
--                   an `analyses` row for `clarification_dialog_states` to
--                   key on.
--
-- Each subject column cascades: a deleted run or check takes its dialog with
-- it. A new, empty table; nothing backfilled, no existing table touched.
--
-- Rollback: server/prisma/rollbacks/20261202002270_issue2270_subject_clarification_dialogs.sql
-- (exercised by server/tests/subject-clarification-dialog-migration-2270.sqlite.test.ts).

-- CreateTable
CREATE TABLE "subject_clarification_dialogs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "impactAnalysisId" TEXT,
    "portfolioAssessmentId" TEXT,
    "projectId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "requirements" TEXT NOT NULL,
    "state" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "subject_clarification_dialogs_impactAnalysisId_fkey" FOREIGN KEY ("impactAnalysisId") REFERENCES "impact_analyses" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "subject_clarification_dialogs_portfolioAssessmentId_fkey" FOREIGN KEY ("portfolioAssessmentId") REFERENCES "portfolio_assessments" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "subject_clarification_dialogs_impactAnalysisId_key" ON "subject_clarification_dialogs"("impactAnalysisId");

-- CreateIndex
CREATE UNIQUE INDEX "subject_clarification_dialogs_portfolioAssessmentId_key" ON "subject_clarification_dialogs"("portfolioAssessmentId");

-- CreateIndex
CREATE INDEX "subject_clarification_dialogs_projectId_idx" ON "subject_clarification_dialogs"("projectId");
