-- Issue #2341 (epic #2328) — the change request gets a name.
--
-- "analyses"."title" (nullable TEXT): the change request's title, set when the
-- run starts and renamed later. Nothing is backfilled: a run from before #2341
-- reads NULL, and the read path generates its title from the run's sources
-- (`generatedChangeRequestTitle`), so no run is ever listed blank and a source document
-- renamed later still names it. The run's sources are not a new table: they
-- are already recorded in "analyses"."metadata" (`documentIds`,
-- `sourceRequirements`).
--
-- Rollback: server/prisma/rollbacks/20261125002341_issue2341_change_request_title.sql
-- (exercised by server/tests/change-request-title-migration-2341.sqlite.test.ts).

-- AlterTable
ALTER TABLE "analyses" ADD COLUMN "title" TEXT;
