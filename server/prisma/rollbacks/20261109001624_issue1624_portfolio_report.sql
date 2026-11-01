-- Reverse of server/prisma/migrations/20261109001624_issue1624_portfolio_report
-- (SQLite). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   sqlite3 <db file> < server/prisma/rollbacks/20261109001624_issue1624_portfolio_report.sql
--
-- It drops the column (SQLite 3.35+; it is neither indexed nor constrained) and
-- forgets the migration, so a later `prisma migrate deploy` applies it again.
-- Every other column of every row is left as it was. The reports are lost: they
-- are stored nowhere else (the portfolio summary in `summary` stays).
-- server/tests/portfolio-report-migration-1624.sqlite.test.ts runs up, this,
-- and up again over seeded rows.

-- One transaction: if the DELETE failed, the column would be gone while the
-- migration still read as applied, and `migrate deploy` would not re-add it.
BEGIN;
ALTER TABLE "portfolio_assessments" DROP COLUMN "report";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261109001624_issue1624_portfolio_report';
COMMIT;
