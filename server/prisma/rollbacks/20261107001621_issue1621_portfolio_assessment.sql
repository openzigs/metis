-- Reverse of server/prisma/migrations/20261107001621_issue1621_portfolio_assessment
-- (SQLite). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   sqlite3 <db file> < server/prisma/rollbacks/20261107001621_issue1621_portfolio_assessment.sql
--
-- It drops the three portfolio assessment tables (children first) and forgets
-- the migration, so a later `prisma migrate deploy` applies it again. No other
-- table is touched: the migration only added these. Every assessment is lost —
-- it is stored nowhere else. server/tests/portfolio-assessment-migration-1621.sqlite.test.ts
-- runs up, this, and up again over seeded rows.

-- One transaction: if the DELETE failed, the tables would be gone while the
-- migration still read as applied, and `migrate deploy` would not recreate them.
BEGIN;
DROP TABLE "portfolio_assessment_repos";
DROP TABLE "portfolio_assessment_products";
DROP TABLE "portfolio_assessments";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261107001621_issue1621_portfolio_assessment';
COMMIT;
