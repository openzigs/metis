-- Reverse of server/prisma/migrations/20261129002301_issue2301_portfolio_requirement_set
-- (SQLite). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   sqlite3 <db file> < server/prisma/rollbacks/20261129002301_issue2301_portfolio_requirement_set.sql
--
-- Drops "portfolio_assessments"."sourceRequirementIds" and forgets the
-- migration, so a later `prisma migrate deploy` applies it again. What is lost:
-- which requirements a check started from a chosen set checked (the check
-- itself, its statement, source project, results and not-checked list stay; its
-- host-picker link then carries the statement instead of the set). Every other
-- column of every row is untouched.
-- server/tests/portfolio-requirement-set-migration-2301.sqlite.test.ts runs up,
-- this, and up again over seeded rows.

BEGIN;
ALTER TABLE "portfolio_assessments" DROP COLUMN "sourceRequirementIds";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261129002301_issue2301_portfolio_requirement_set';
COMMIT;
