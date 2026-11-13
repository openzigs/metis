-- Reverse of server/prisma/postgres/migrations/20261126002345_issue2345_change_request_checks
-- (Postgres). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f server/prisma/postgres/rollbacks/20261126002345_issue2345_change_request_checks.sql
--
-- Drops both indexes and the three columns and forgets the migration, so a
-- later `prisma migrate deploy` applies it again. What is lost: which change
-- request each impact analysis and portfolio check was started from, and which
-- checks ran on unapproved requirements. Idempotent, like the forward migration
-- (#556). The SQLite twin's up -> reverse -> up is tested in
-- server/tests/change-request-checks-migration-2345.sqlite.test.ts.

DROP INDEX IF EXISTS "impact_analyses_sourceAnalysisId_idx";
DROP INDEX IF EXISTS "portfolio_assessments_sourceAnalysisId_idx";
ALTER TABLE "impact_analyses" DROP COLUMN IF EXISTS "sourceAnalysisId";
ALTER TABLE "portfolio_assessments" DROP COLUMN IF EXISTS "preApproval";
ALTER TABLE "portfolio_assessments" DROP COLUMN IF EXISTS "sourceAnalysisId";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261126002345_issue2345_change_request_checks';
