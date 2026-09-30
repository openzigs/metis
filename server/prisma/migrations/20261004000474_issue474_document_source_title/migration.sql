-- Issue #474 — record which path wrote each document, and the title a source
-- supplied, so readers stop inferring both from the filename.
--
-- The Workbench filed any document whose filename matched a connector pattern
-- (`jira:…`, `confluence:…`, `connector:repo:…`, `connector:db:…`) under that
-- source, so an upload literally named `jira:ABC-1` was shown as a Jira issue.
-- New rows get `source` from the code that writes them; this backfill
-- classifies existing rows once.
--
-- Backfill: a connector always wrote `text/markdown`, so a row is re-classified
-- only when its filename matches the connector's pattern AND its MIME type is
-- `text/markdown`. `substr` rather than `LIKE`: SQLite's LIKE is
-- case-insensitive and treats `_` as a wildcard. An existing markdown upload
-- that was itself named like a connector row cannot be told apart and is
-- classified as that source; every row written after this migration is exact.
-- `title` stays null for existing Confluence rows until their next ingest.
--
-- Rollback: ALTER TABLE "documents" DROP COLUMN "title";
--           ALTER TABLE "documents" DROP COLUMN "source";

-- AlterTable
ALTER TABLE "documents" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'upload';
ALTER TABLE "documents" ADD COLUMN "title" TEXT;

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
