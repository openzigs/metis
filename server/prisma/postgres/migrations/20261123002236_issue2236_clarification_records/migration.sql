-- Issue #2236 (epic #2227) — clarification answers become project knowledge.
-- Postgres twin of server/prisma/migrations/20261123002236_issue2236_clarification_records;
-- see that file for the rationale. One new table, cascading with the project.
--
-- Structural DDL is idempotent (#556), so the full history applies from empty.
--
-- Rollback: server/prisma/postgres/rollbacks/20261123002236_issue2236_clarification_records.sql

-- CreateTable
CREATE TABLE IF NOT EXISTS "clarification_records" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "questionKey" TEXT NOT NULL,
    "analysisId" TEXT,
    "specKitFeature" TEXT,
    "questionId" TEXT,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "answeredById" TEXT,
    "answeredAt" TIMESTAMP(3) NOT NULL,
    "ambiguityField" TEXT,
    "sourceDocumentId" TEXT,
    "sourceFilename" TEXT,
    "sourceHeadingPath" TEXT NOT NULL DEFAULT '[]',
    "sourceQuote" TEXT,
    "requirementIds" TEXT NOT NULL DEFAULT '[]',
    "productIds" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'settled',
    "reopenedAt" TIMESTAMP(3),
    "knowledgeDocumentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clarification_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "clarification_records_analysisId_idx" ON "clarification_records"("analysisId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "clarification_records_projectId_status_idx" ON "clarification_records"("projectId", "status");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "clarification_records_projectId_questionKey_key" ON "clarification_records"("projectId", "questionKey");

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clarification_records_projectId_fkey') THEN
    EXECUTE 'ALTER TABLE "clarification_records" ADD CONSTRAINT "clarification_records_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END
$idem$;
