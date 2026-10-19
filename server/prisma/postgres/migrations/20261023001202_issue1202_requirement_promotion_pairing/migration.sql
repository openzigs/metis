-- Issue #1202 — store the pairing promotion makes between an approved
-- STRUCTURED requirement and the `Requirement` row written from it (Postgres
-- mirror; see the SQLite migration of the same name for the full rationale).
--
-- `promotedStructuredId` is the structured id (`REQ-3`), and
-- `promotedStructuredRunId` the extraction run it belongs to (#909).
-- `promotedSynthesisKeys` is a JSON array of keys of the synthesis items the
-- row took its criteria and evidence from. On the row itself, so a re-run's
-- hard delete (#57) takes the pairing with it.
--
-- No backfill: NULL means "not recorded", and those rows keep title matching.
-- Idempotent DDL (`IF NOT EXISTS`) so the history replays over the cumulative
-- `00000000000000_init` baseline (issue #556 guard). Column additions are not
-- appended to the baseline (as #1063's `sourceCandidateIds` was not); the
-- baseline's table count is unchanged.
--
-- Rollback (documentation):
--   ALTER TABLE "requirements" DROP COLUMN "promotedStructuredId";
--   ALTER TABLE "requirements" DROP COLUMN "promotedStructuredRunId";
--   ALTER TABLE "requirements" DROP COLUMN "promotedSynthesisKeys";
ALTER TABLE "requirements" ADD COLUMN IF NOT EXISTS "promotedStructuredId" TEXT;
ALTER TABLE "requirements" ADD COLUMN IF NOT EXISTS "promotedStructuredRunId" TEXT;
ALTER TABLE "requirements" ADD COLUMN IF NOT EXISTS "promotedSynthesisKeys" TEXT;
