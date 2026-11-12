-- Issue #2280 (epic #2227) — saved document readings.
--
--   saved_document_readings  one row per successful reading of a document by
--                   the document reader (`server/src/lib/document-reader/`),
--                   keyed by the document, its file (`checksum`), the reader
--                   version, the model that read it and the SHA-256 of the text
--                   it read. Read by `reading-cache.ts`, so a second
--                   Requirements Analysis or Impact Analysis of an unchanged
--                   file makes no model call.
--
-- `documentId` cascades: a hard-deleted document takes its readings with it
-- (the soft delete removes them itself). A new, empty table; nothing backfilled.
--
-- Rollback: server/prisma/rollbacks/20261123002280_issue2280_saved_document_readings.sql
-- (exercised by server/tests/saved-document-reading-migration-2280.sqlite.test.ts).

-- CreateTable
CREATE TABLE "saved_document_readings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "readerVersion" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "textHash" TEXT NOT NULL,
    "reading" TEXT NOT NULL,
    "usage" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "saved_document_readings_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "saved_document_readings_projectId_documentId_idx" ON "saved_document_readings"("projectId", "documentId");

-- CreateIndex
CREATE UNIQUE INDEX "saved_document_readings_key" ON "saved_document_readings"("documentId", "checksum", "readerVersion", "model", "textHash");
