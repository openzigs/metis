-- Issue #525 — classify generated documents by their synthetic id, not their
-- filename.
--
-- The #474 backfill marked a row `generated` when its filename started with
-- `generated-doc-` and it was markdown, so a markdown upload with that name was
-- misfiled as a generated document. Every generated row has, since the first
-- release, been written with the id `gendoc-<generatedDocumentId>[:<revision>]`
-- (`generatedDocSyntheticDocumentId` in `docs-gen/generated-doc-publication.ts`),
-- and no other writer mints that prefix (uploads and connectors take a cuid), so
-- the id decides both directions exactly. `substr` rather than `LIKE`: SQLite's
-- LIKE is case-insensitive and treats `_` as a wildcard.
--
-- Rollback: data-only and derived from #474's rule; to restore it, re-run
-- #474's filename backfill for generated rows:
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
