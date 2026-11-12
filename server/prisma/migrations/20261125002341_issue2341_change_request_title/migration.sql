-- Issue #2341 (epic #2328) — the change request gets a name.
--
-- "analyses"."title" (nullable TEXT): the change request's title. Every run
-- started after this migration stores one (the analyst's, else the default
-- `createAnalysis` writes), so the title is searchable and sortable in SQL.
-- "analyses"."titleGenerated" (BOOLEAN, default false): true when Metis
-- proposed the title, false once a person typed or renamed it.
--
-- Existing rows are NOT backfilled here. Their default title is the first
-- source document's name (a join through the JSON "metadata"), "and N more",
-- control characters stripped, an ellipsis at 200 characters: a rule that
-- cannot be written identically in SQLite and Postgres SQL. So the server
-- applies the one TypeScript rule (`backfillChangeRequestTitles`) at startup,
-- idempotently, to every row whose title is still NULL. Until it has run, the
-- read path generates the same title for such a row.
--
-- Rollback: server/prisma/rollbacks/20261125002341_issue2341_change_request_title.sql
-- (exercised by server/tests/change-request-title-migration-2341.sqlite.test.ts).

-- AlterTable
ALTER TABLE "analyses" ADD COLUMN "title" TEXT;
ALTER TABLE "analyses" ADD COLUMN "titleGenerated" BOOLEAN NOT NULL DEFAULT false;
