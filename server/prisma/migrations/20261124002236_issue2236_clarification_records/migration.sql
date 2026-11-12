-- Issue #2236 (epic #2227) — clarification answers become project knowledge:
-- one row per answered clarifying question, with who answered and when, the
-- source paragraph it was asked about and the requirements and products it
-- applies to.
--
--   clarification_records  scoped by `projectId` (cascades with the project).
--                   One row per (project, question key), so a later analysis
--                   of the project finds a settled answer instead of asking
--                   again. No foreign key to the analysis or the user: the
--                   answer outlives both.
--
-- One new, empty table.
--
-- Rollback: server/prisma/rollbacks/20261124002236_issue2236_clarification_records.sql
-- (exercised by server/tests/clarification-records-migration-2236.sqlite.test.ts).

-- CreateTable
CREATE TABLE "clarification_records" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "questionKey" TEXT NOT NULL,
    "analysisId" TEXT,
    "specKitFeature" TEXT,
    "questionId" TEXT,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "answeredById" TEXT,
    "answeredAt" DATETIME NOT NULL,
    "ambiguityField" TEXT,
    "sourceDocumentId" TEXT,
    "sourceFilename" TEXT,
    "sourceHeadingPath" TEXT NOT NULL DEFAULT '[]',
    "sourceQuote" TEXT,
    "requirementIds" TEXT NOT NULL DEFAULT '[]',
    "productIds" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'settled',
    "reopenedAt" DATETIME,
    "knowledgeDocumentId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "clarification_records_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "clarification_records_analysisId_idx" ON "clarification_records"("analysisId");

-- CreateIndex
CREATE INDEX "clarification_records_projectId_status_idx" ON "clarification_records"("projectId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "clarification_records_projectId_questionKey_key" ON "clarification_records"("projectId", "questionKey");
