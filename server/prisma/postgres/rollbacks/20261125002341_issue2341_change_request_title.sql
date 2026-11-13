-- Reverse of server/prisma/postgres/migrations/20261125002341_issue2341_change_request_title
-- (Postgres). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f server/prisma/postgres/rollbacks/20261125002341_issue2341_change_request_title.sql
--
-- Drops "analyses"."title" and "analyses"."titleGenerated" and forgets the
-- migration, so a later `prisma migrate deploy` applies it again. What is lost:
-- every change request's stored title and whether a person set it; after the
-- re-apply the startup backfill names each run again from its sources.
-- Idempotent, like the forward migration (#556). The SQLite twin's
-- up -> reverse -> up is tested in
-- server/tests/change-request-title-migration-2341.sqlite.test.ts.

ALTER TABLE "analyses" DROP COLUMN IF EXISTS "titleGenerated";
ALTER TABLE "analyses" DROP COLUMN IF EXISTS "title";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261125002341_issue2341_change_request_title';
