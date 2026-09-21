-- Epic #157 — RAG hardening: quarantine, ACLs, Chronicle, red-team telemetry.

-- AlterTable: Document
ALTER TABLE "documents" ADD COLUMN "indexState" TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE "documents" ADD COLUMN "autoApproveTrusted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "documents" ADD COLUMN "aclSubjects" TEXT NOT NULL DEFAULT '[]';

-- AlterTable: KnowledgeChunk
ALTER TABLE "knowledge_chunks" ADD COLUMN "aclSubjects" TEXT NOT NULL DEFAULT '[]';

-- AlterTable: Project
ALTER TABLE "projects" ADD COLUMN "autoApproveTrustedSources" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "projects" ADD COLUMN "chronicleEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "projects" ADD COLUMN "chronicleTtlDays" INTEGER NOT NULL DEFAULT 28;
ALTER TABLE "projects" ADD COLUMN "redTeamLastRunAt" DATETIME;
ALTER TABLE "projects" ADD COLUMN "redTeamLastScore" REAL;

-- CreateTable: QuarantineChunk
CREATE TABLE "quarantine_chunks" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "documentId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "ord" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "embedding" TEXT NOT NULL,
    "metadata" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "quarantine_chunks_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "quarantine_chunks_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "quarantine_chunks_projectId_idx" ON "quarantine_chunks"("projectId");
CREATE INDEX "quarantine_chunks_documentId_ord_idx" ON "quarantine_chunks"("documentId", "ord");

-- CreateTable: ChronicleEntry
CREATE TABLE "chronicle_entries" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "sourceSessionId" TEXT,
    "expiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "chronicle_entries_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "chronicle_entries_projectId_key_idx" ON "chronicle_entries"("projectId", "key");
CREATE INDEX "chronicle_entries_expiresAt_idx" ON "chronicle_entries"("expiresAt");

-- Index for indexState filtering
CREATE INDEX "documents_projectId_indexState_idx" ON "documents"("projectId", "indexState");
