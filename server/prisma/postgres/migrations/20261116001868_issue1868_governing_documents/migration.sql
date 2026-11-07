-- Issue #1868 (epic #1866) — governing documents, uploaded once per workspace.
-- Postgres twin of
-- server/prisma/migrations/20261116001868_issue1868_governing_documents;
-- see that file for the rationale. Four new tables: documents (cascading with
-- the workspace), their revisions, the rules extracted from a revision, and
-- each rule's edit history.
--
-- Structural DDL is idempotent (#556), so the full history applies from empty.
--
-- Rollback: server/prisma/postgres/rollbacks/20261116001868_issue1868_governing_documents.sql

-- CreateTable
CREATE TABLE IF NOT EXISTS "governing_documents" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "framework" TEXT,
    "currentRevisionId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "governing_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "governing_document_revisions" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "revisionLabel" TEXT NOT NULL,
    "effectiveDate" TIMESTAMP(3) NOT NULL,
    "storagePath" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "extractedText" TEXT NOT NULL,
    "indexState" TEXT NOT NULL DEFAULT 'pending',
    "extractionState" TEXT NOT NULL DEFAULT 'pending',
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "governing_document_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "governing_rules" (
    "id" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "controlId" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "clauseRef" TEXT NOT NULL,
    "clauseStart" INTEGER NOT NULL,
    "clauseEnd" INTEGER NOT NULL,
    "clauseExcerpt" TEXT NOT NULL,
    "category" TEXT,
    "editedById" TEXT,
    "editedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "governing_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "governing_rule_edits" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "editedById" TEXT NOT NULL,
    "before" TEXT NOT NULL,
    "after" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "governing_rule_edits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "governing_documents_currentRevisionId_key" ON "governing_documents"("currentRevisionId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "governing_documents_workspaceId_deletedAt_idx" ON "governing_documents"("workspaceId", "deletedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "governing_document_revisions_documentId_createdAt_idx" ON "governing_document_revisions"("documentId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "governing_document_revisions_documentId_revisionLabel_key" ON "governing_document_revisions"("documentId", "revisionLabel");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "governing_rules_revisionId_deletedAt_idx" ON "governing_rules"("revisionId", "deletedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "governing_rule_edits_ruleId_createdAt_idx" ON "governing_rule_edits"("ruleId", "createdAt");

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'governing_documents_workspaceId_fkey') THEN
    EXECUTE 'ALTER TABLE "governing_documents" ADD CONSTRAINT "governing_documents_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'governing_documents_currentRevisionId_fkey') THEN
    EXECUTE 'ALTER TABLE "governing_documents" ADD CONSTRAINT "governing_documents_currentRevisionId_fkey" FOREIGN KEY ("currentRevisionId") REFERENCES "governing_document_revisions"("id") ON DELETE SET NULL ON UPDATE CASCADE';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'governing_document_revisions_documentId_fkey') THEN
    EXECUTE 'ALTER TABLE "governing_document_revisions" ADD CONSTRAINT "governing_document_revisions_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "governing_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'governing_rules_revisionId_fkey') THEN
    EXECUTE 'ALTER TABLE "governing_rules" ADD CONSTRAINT "governing_rules_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "governing_document_revisions"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'governing_rule_edits_ruleId_fkey') THEN
    EXECUTE 'ALTER TABLE "governing_rule_edits" ADD CONSTRAINT "governing_rule_edits_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "governing_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END
$idem$;
