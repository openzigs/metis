-- Reverse of server/prisma/postgres/migrations/20261129002301_issue2301_portfolio_requirement_set
-- (Postgres). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f server/prisma/postgres/rollbacks/20261129002301_issue2301_portfolio_requirement_set.sql
--
-- Drops the column and forgets the migration, so a later `prisma migrate
-- deploy` applies it again. What is lost: which requirements a check started
-- from a chosen set checked. Idempotent, like the forward migration (#556). The
-- SQLite twin's up -> reverse -> up is tested in
-- server/tests/portfolio-requirement-set-migration-2301.sqlite.test.ts.

ALTER TABLE "portfolio_assessments" DROP COLUMN IF EXISTS "sourceRequirementIds";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261129002301_issue2301_portfolio_requirement_set';
