-- Reverse of server/prisma/migrations/20261125002341_issue2341_change_request_title
-- (SQLite). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   sqlite3 <db file> < server/prisma/rollbacks/20261125002341_issue2341_change_request_title.sql
--
-- Drops "analyses"."title" and "analyses"."titleGenerated" and forgets the
-- migration, so a later `prisma migrate deploy` applies it again. What is lost:
-- every change request's stored title (the analyst's, or the default) and
-- whether a person set it. After the re-apply, the startup backfill names each
-- run again from its sources, as it names a run from before #2341. Every other
-- column of every row is untouched.
-- server/tests/change-request-title-migration-2341.sqlite.test.ts runs up,
-- this, and up again over a seeded row.

BEGIN;
ALTER TABLE "analyses" DROP COLUMN "titleGenerated";
ALTER TABLE "analyses" DROP COLUMN "title";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261125002341_issue2341_change_request_title';
COMMIT;
