-- Reverse of server/prisma/postgres/migrations/20261203002593_issue2593_impact_database_connected
-- (Postgres). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f server/prisma/postgres/rollbacks/20261203002593_issue2593_impact_database_connected.sql
--
-- Drops the column and forgets the migration, so a later
-- `prisma migrate deploy` applies it again. What is lost: whether each run read
-- each project's database; every run then reads as one recorded before #2593.
-- Idempotent, like the forward migration (#556). The postgres-migrate-deploy CI
-- job applies up -> this -> up over a seeded run; the SQLite twin's round trip
-- is in server/tests/impact-database-connected-2593.sqlite.test.ts.

ALTER TABLE "impact_analysis_projects" DROP COLUMN IF EXISTS "databaseConnected";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261203002593_issue2593_impact_database_connected';
