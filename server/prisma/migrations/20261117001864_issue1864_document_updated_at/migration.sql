-- Issue #1864 (epic #1829) — `documents.updatedAt`, so the project content
-- version (`server/src/lib/projects/content-version.ts`) stops hashing every
-- document row on each cached chat tool call. Prisma sets it on every create
-- and update (`@updatedAt`). The version reads the project's row count, the
-- latest value, and the rows written just before it, through the new
-- (`projectId`, `updatedAt`) index.
--
-- Nullable DATETIME (SQLite cannot add a column whose default is
-- CURRENT_TIMESTAMP), nothing backfilled: existing rows read null until their
-- next update, and the row count still covers them.
--
-- Rollback: server/prisma/rollbacks/20261117001864_issue1864_document_updated_at.sql
-- (exercised by server/tests/tool-result-cache-1843.sqlite.test.ts).

-- AlterTable
ALTER TABLE "documents" ADD COLUMN "updatedAt" DATETIME;

-- CreateIndex
CREATE INDEX "documents_projectId_updatedAt_idx" ON "documents"("projectId", "updatedAt");
