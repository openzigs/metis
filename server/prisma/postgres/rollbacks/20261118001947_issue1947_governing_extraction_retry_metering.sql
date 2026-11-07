-- Reverse of server/prisma/postgres/migrations/20261118001947_issue1947_governing_extraction_retry_metering
-- (Postgres). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f server/prisma/postgres/rollbacks/20261118001947_issue1947_governing_extraction_retry_metering.sql
--
-- Drops "extractionStartedAt", deletes the workspace-level "token_usages" rows
-- (no project: they cannot satisfy NOT NULL), restores NOT NULL on "projectId"
-- and drops "workspaceId" with its index, then forgets the migration, so a
-- later `prisma migrate deploy` applies it again. What is lost: the metered
-- spend of governing rule extraction, and when each extraction run began.
-- Idempotent, like the forward migration (#556). The SQLite twin's
-- up -> reverse -> up is tested in
-- server/tests/governing-extraction-retry-metering-migration-1947.sqlite.test.ts.

ALTER TABLE "governing_document_revisions" DROP COLUMN IF EXISTS "extractionStartedAt";
DELETE FROM "token_usages" WHERE "projectId" IS NULL;
ALTER TABLE "token_usages" ALTER COLUMN "projectId" SET NOT NULL;
DROP INDEX IF EXISTS "token_usages_workspaceId_createdAt_idx";
ALTER TABLE "token_usages" DROP COLUMN IF EXISTS "workspaceId";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261118001947_issue1947_governing_extraction_retry_metering';
