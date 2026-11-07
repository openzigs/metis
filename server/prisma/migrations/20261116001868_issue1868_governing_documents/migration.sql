-- Issue #1868 (epic #1866) — governing documents: a company's policies and
-- control frameworks, uploaded once per workspace.
--
--   governing_documents           one per policy, scoped by `workspaceId`
--                   (cascades with the workspace row). `currentRevisionId`
--                   points at the revision analysis checks against; it is
--                   set null if that revision is deleted.
--   governing_document_revisions  each uploaded revision, with its parsed
--                   text, quarantine `indexState` and rule `extractionState`.
--                   One `revisionLabel` per document.
--   governing_rules               the atomic rules extracted from a revision,
--                   each cited to `extractedText` by character offsets.
--   governing_rule_edits          the edit history of a rule.
--
-- No foreign key to `projects` (deleting a project leaves every row) and none
-- to `users` (authorship outlives the account). Four new, empty tables.
--
-- Rollback: server/prisma/rollbacks/20261116001868_issue1868_governing_documents.sql
-- (exercised by server/tests/governing-documents-migration-1868.sqlite.test.ts).

-- CreateTable
CREATE TABLE "governing_documents" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "framework" TEXT,
    "currentRevisionId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" DATETIME,
    CONSTRAINT "governing_documents_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "governing_documents_currentRevisionId_fkey" FOREIGN KEY ("currentRevisionId") REFERENCES "governing_document_revisions" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "governing_document_revisions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "documentId" TEXT NOT NULL,
    "revisionLabel" TEXT NOT NULL,
    "effectiveDate" DATETIME NOT NULL,
    "storagePath" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "extractedText" TEXT NOT NULL,
    "indexState" TEXT NOT NULL DEFAULT 'pending',
    "extractionState" TEXT NOT NULL DEFAULT 'pending',
    "uploadedById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "governing_document_revisions_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "governing_documents" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "governing_rules" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "revisionId" TEXT NOT NULL,
    "controlId" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "clauseRef" TEXT NOT NULL,
    "clauseStart" INTEGER NOT NULL,
    "clauseEnd" INTEGER NOT NULL,
    "clauseExcerpt" TEXT NOT NULL,
    "category" TEXT,
    "editedById" TEXT,
    "editedAt" DATETIME,
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "governing_rules_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "governing_document_revisions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "governing_rule_edits" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ruleId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "editedById" TEXT NOT NULL,
    "before" TEXT NOT NULL,
    "after" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "governing_rule_edits_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "governing_rules" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "governing_documents_currentRevisionId_key" ON "governing_documents"("currentRevisionId");

-- CreateIndex
CREATE INDEX "governing_documents_workspaceId_deletedAt_idx" ON "governing_documents"("workspaceId", "deletedAt");

-- CreateIndex
CREATE INDEX "governing_document_revisions_documentId_createdAt_idx" ON "governing_document_revisions"("documentId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "governing_document_revisions_documentId_revisionLabel_key" ON "governing_document_revisions"("documentId", "revisionLabel");

-- CreateIndex
CREATE INDEX "governing_rules_revisionId_deletedAt_idx" ON "governing_rules"("revisionId", "deletedAt");

-- CreateIndex
CREATE INDEX "governing_rule_edits_ruleId_createdAt_idx" ON "governing_rule_edits"("ruleId", "createdAt");
