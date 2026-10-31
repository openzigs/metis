-- Reverse of server/prisma/postgres/migrations/20261107001621_issue1621_portfolio_assessment
-- (Postgres). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f server/prisma/postgres/rollbacks/20261107001621_issue1621_portfolio_assessment.sql
--
-- Drops the three portfolio assessment tables (children first) and forgets the
-- migration, so a later `prisma migrate deploy` applies it again. No other table
-- is touched; every assessment is lost. Idempotent, like the forward migration
-- (#556). The SQLite twin's up -> reverse -> up is tested in
-- server/tests/portfolio-assessment-migration-1621.sqlite.test.ts.

DROP TABLE IF EXISTS "portfolio_assessment_repos";
DROP TABLE IF EXISTS "portfolio_assessment_products";
DROP TABLE IF EXISTS "portfolio_assessments";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261107001621_issue1621_portfolio_assessment';
