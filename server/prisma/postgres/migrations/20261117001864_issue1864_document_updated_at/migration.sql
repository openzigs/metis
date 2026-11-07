-- Issue #1864 (epic #1829) — `documents.updatedAt` and its index (Postgres
-- twin of server/prisma/migrations/20261117001864_issue1864_document_updated_at;
-- see that file for the rationale). One nullable column, nothing backfilled.
-- Idempotent (#556).
--
-- Rollback: server/prisma/postgres/rollbacks/20261117001864_issue1864_document_updated_at.sql

-- AlterTable
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "documents_projectId_updatedAt_idx" ON "documents"("projectId", "updatedAt");
