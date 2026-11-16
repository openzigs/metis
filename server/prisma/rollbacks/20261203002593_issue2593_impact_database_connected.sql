-- Reverse of server/prisma/migrations/20261203002593_issue2593_impact_database_connected
-- (SQLite). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   sqlite3 <db file> < server/prisma/rollbacks/20261203002593_issue2593_impact_database_connected.sql
--
-- Needs SQLite 3.35 or later (`ALTER TABLE ... DROP COLUMN`); check with
-- `sqlite3 --version`. The server's bundled engine (better-sqlite3) is newer.
--
-- Drops the columns and forgets the migration, so a later
-- `prisma migrate deploy` applies it again. What is lost: whether each run read
-- each project's database, and why not; every run then reads as one recorded before #2593
-- (no "database not checked" note). Every other column of every row is untouched.
-- server/tests/impact-database-connected-2593.sqlite.test.ts runs up, this, and
-- up again over a seeded run.

BEGIN;
ALTER TABLE "impact_analysis_projects" DROP COLUMN "databaseNotCheckedReason";
ALTER TABLE "impact_analysis_projects" DROP COLUMN "databaseConnected";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261203002593_issue2593_impact_database_connected';
COMMIT;
