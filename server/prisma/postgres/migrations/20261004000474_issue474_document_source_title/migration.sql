-- Issue #474 — document `source` and `title` (Postgres mirror).
-- See the SQLite migration of the same name for the rationale and the
-- backfill's limits. `IF NOT EXISTS` keeps the full chain idempotent (#556).
--
-- Rollback: ALTER TABLE "documents" DROP COLUMN IF EXISTS "title";
--           ALTER TABLE "documents" DROP COLUMN IF EXISTS "source";

-- AlterTable
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'upload';
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "title" TEXT;

-- Backfill
UPDATE "documents" SET "source" = 'repo'
  WHERE "source" = 'upload' AND substr("filename", 1, 15) = 'connector:repo:' AND "mimeType" = 'text/markdown';
UPDATE "documents" SET "source" = 'db'
  WHERE "source" = 'upload' AND substr("filename", 1, 13) = 'connector:db:' AND "mimeType" = 'text/markdown';
UPDATE "documents" SET "source" = 'confluence'
  WHERE "source" = 'upload' AND substr("filename", 1, 11) = 'confluence:' AND "mimeType" = 'text/markdown';
UPDATE "documents" SET "source" = 'jira'
  WHERE "source" = 'upload' AND substr("filename", 1, 5) = 'jira:' AND "mimeType" = 'text/markdown';
UPDATE "documents" SET "source" = 'generated'
  WHERE "source" = 'upload' AND substr("filename", 1, 14) = 'generated-doc-' AND "mimeType" = 'text/markdown';
