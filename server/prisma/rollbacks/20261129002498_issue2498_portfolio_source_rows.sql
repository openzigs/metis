-- Reverse of server/prisma/migrations/20261129002498_issue2498_portfolio_source_rows
-- (SQLite). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   sqlite3 <db file> < server/prisma/rollbacks/20261129002498_issue2498_portfolio_source_rows.sql
--
-- Drops "portfolio_assessments"."sourceRows" and forgets the migration, so a
-- later `prisma migrate deploy` applies it again (and backfills from the rows
-- that exist then). What is lost: which rows each check read, so a check's
-- restricted row hard-deleted since no longer hides what it wrote (the gap
-- #2498 closed). Every other column of every row is untouched.
-- server/tests/portfolio-source-rows-migration-2498.sqlite.test.ts runs up,
-- this, and up again over seeded rows.

BEGIN;
ALTER TABLE "portfolio_assessments" DROP COLUMN "sourceRows";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261129002498_issue2498_portfolio_source_rows';
COMMIT;
