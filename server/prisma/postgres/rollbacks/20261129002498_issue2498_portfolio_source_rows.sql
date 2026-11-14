-- Reverse of server/prisma/postgres/migrations/20261129002498_issue2498_portfolio_source_rows
-- (Postgres). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f server/prisma/postgres/rollbacks/20261129002498_issue2498_portfolio_source_rows.sql
--
-- Drops "portfolio_assessments"."sourceRows" and forgets the migration, so a
-- later `prisma migrate deploy` applies it again (and backfills from the rows
-- that exist then). What is lost: which rows each check read, so a check's
-- restricted row hard-deleted since no longer hides what it wrote (the gap
-- #2498 closed). Idempotent, like the forward migration (#556). The SQLite
-- twin's up -> reverse -> up is tested in
-- server/tests/portfolio-source-rows-migration-2498.sqlite.test.ts.

ALTER TABLE "portfolio_assessments" DROP COLUMN IF EXISTS "sourceRows";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261129002498_issue2498_portfolio_source_rows';
