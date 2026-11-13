-- Reverse of server/prisma/migrations/20261126002345_issue2345_change_request_checks
-- (SQLite). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   sqlite3 <db file> < server/prisma/rollbacks/20261126002345_issue2345_change_request_checks.sql
--
-- Drops both indexes, "impact_analyses"."sourceAnalysisId" and
-- "portfolio_assessments"."sourceAnalysisId" / "preApproval", and forgets the
-- migration, so a later `prisma migrate deploy` applies it again. What is lost:
-- which change request each impact analysis and portfolio check was started
-- from, and which checks ran on unapproved requirements. Every other column of
-- every row is untouched.
-- server/tests/change-request-checks-migration-2345.sqlite.test.ts runs up,
-- this, and up again over seeded rows.

BEGIN;
DROP INDEX IF EXISTS "impact_analyses_sourceAnalysisId_idx";
DROP INDEX IF EXISTS "portfolio_assessments_sourceAnalysisId_idx";
ALTER TABLE "impact_analyses" DROP COLUMN "sourceAnalysisId";
ALTER TABLE "portfolio_assessments" DROP COLUMN "preApproval";
ALTER TABLE "portfolio_assessments" DROP COLUMN "sourceAnalysisId";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261126002345_issue2345_change_request_checks';
COMMIT;
