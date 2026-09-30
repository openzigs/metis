-- Issue #525 — classify generated documents by their synthetic id, not their
-- filename (Postgres mirror). See the SQLite migration of the same name for the
-- rationale. Both statements are guarded on the current `source`, so the
-- migration is a no-op when run again.
--
-- Rollback: data-only; re-run #474's filename backfill for generated rows:
--   UPDATE "documents" SET "source" = 'upload'
--     WHERE "source" = 'generated' AND substr("id", 1, 7) = 'gendoc-'
--       AND NOT (substr("filename", 1, 14) = 'generated-doc-' AND "mimeType" = 'text/markdown');
--   UPDATE "documents" SET "source" = 'generated'
--     WHERE "source" = 'upload' AND substr("filename", 1, 14) = 'generated-doc-'
--       AND "mimeType" = 'text/markdown';

UPDATE "documents" SET "source" = 'upload'
  WHERE "source" = 'generated' AND substr("id", 1, 7) <> 'gendoc-';
UPDATE "documents" SET "source" = 'generated'
  WHERE "source" = 'upload' AND substr("id", 1, 7) = 'gendoc-';
