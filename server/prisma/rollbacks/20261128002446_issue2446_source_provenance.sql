-- Reverse of server/prisma/migrations/20261128002446_issue2446_source_provenance
-- (SQLite). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   sqlite3 <db file> < server/prisma/rollbacks/20261128002446_issue2446_source_provenance.sql
--
-- Drops the four columns and forgets the migration, so a later
-- `prisma migrate deploy` applies it again. What is lost: the sources recorded
-- on findings, requirements and cross-document findings written since, and
-- which runs recorded them; after a re-apply every run reads as one from
-- before #2446 (the shared-audience rule). Every other column of every row is
-- untouched.
-- server/tests/source-provenance-migration-2446.sqlite.test.ts runs up, this,
-- and up again over seeded rows.

BEGIN;
ALTER TABLE "cross_doc_findings" DROP COLUMN "sourceIds";
ALTER TABLE "requirements" DROP COLUMN "sourceIds";
ALTER TABLE "findings" DROP COLUMN "sourceIds";
ALTER TABLE "analyses" DROP COLUMN "sourceAccess";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261128002446_issue2446_source_provenance';
COMMIT;
