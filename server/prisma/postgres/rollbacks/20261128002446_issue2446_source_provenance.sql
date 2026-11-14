-- Reverse of server/prisma/postgres/migrations/20261128002446_issue2446_source_provenance
-- (Postgres). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f server/prisma/postgres/rollbacks/20261128002446_issue2446_source_provenance.sql
--
-- Drops the four columns and forgets the migration, so a later
-- `prisma migrate deploy` applies it again. What is lost: the sources recorded
-- on findings, requirements and cross-document findings written since, and
-- which runs recorded them; after a re-apply every run reads as one from
-- before #2446 (the shared-audience rule). Idempotent, like the forward
-- migration (#556). The SQLite twin's up -> reverse -> up is tested in
-- server/tests/source-provenance-migration-2446.sqlite.test.ts.

ALTER TABLE "cross_doc_findings" DROP COLUMN IF EXISTS "sourceIds";
ALTER TABLE "requirements" DROP COLUMN IF EXISTS "sourceIds";
ALTER TABLE "findings" DROP COLUMN IF EXISTS "sourceIds";
ALTER TABLE "analyses" DROP COLUMN IF EXISTS "sourceAccess";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261128002446_issue2446_source_provenance';
