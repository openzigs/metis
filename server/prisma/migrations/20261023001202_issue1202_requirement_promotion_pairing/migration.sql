-- Issue #1202 — store the pairing promotion makes between an approved
-- STRUCTURED requirement and the `Requirement` row written from it.
--
-- Promotion (#730) writes one row per approved structured requirement but
-- recorded only the structured ids, so every later step that needed the link
-- guessed it by matching titles: clarification answers (#1031) and the
-- synthesis items a row draws its criteria from (#1033). Neighbouring
-- requirements whose bodies use each other's title words kept defeating that.
--
-- `promotedStructuredId` is the structured id (`REQ-3`), and
-- `promotedStructuredRunId` the extraction run it belongs to (every run numbers
-- its list from `REQ-001`, #909). `promotedSynthesisKeys` is a JSON array of
-- keys of the synthesis items the row took its criteria and evidence from.
-- Columns on the row itself, not a side table: a re-run hard-deletes the rows
-- (#57), and the pairing goes with them.
--
-- No backfill: which structured requirement an existing row came from was
-- never stored. NULL means "not recorded", and those rows keep title matching.
-- Nullable columns with no default are a metadata-only change.
--
-- Rollback (documentation):
--   ALTER TABLE "requirements" DROP COLUMN "promotedStructuredId";
--   ALTER TABLE "requirements" DROP COLUMN "promotedStructuredRunId";
--   ALTER TABLE "requirements" DROP COLUMN "promotedSynthesisKeys";
-- After it every row is matched by title again, as before #1202.
ALTER TABLE "requirements" ADD COLUMN "promotedStructuredId" TEXT;
ALTER TABLE "requirements" ADD COLUMN "promotedStructuredRunId" TEXT;
ALTER TABLE "requirements" ADD COLUMN "promotedSynthesisKeys" TEXT;
