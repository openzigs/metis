-- Reverse of server/prisma/postgres/migrations/20261109001624_issue1624_portfolio_report
-- (Postgres). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f server/prisma/postgres/rollbacks/20261109001624_issue1624_portfolio_report.sql
--
-- Drops the column and forgets the migration, so a later `prisma migrate
-- deploy` applies it again. Every other column of every row is left as it was;
-- the reports are lost. Idempotent, like the forward migration (#556). The
-- SQLite twin's up -> reverse -> up is tested in
-- server/tests/portfolio-report-migration-1624.sqlite.test.ts.

ALTER TABLE "portfolio_assessments" DROP COLUMN IF EXISTS "report";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261109001624_issue1624_portfolio_report';
