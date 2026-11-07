-- Reverse of server/prisma/postgres/migrations/20261117001864_issue1864_document_updated_at
-- (Postgres). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f server/prisma/postgres/rollbacks/20261117001864_issue1864_document_updated_at.sql
--
-- Drops the index and the column and forgets the migration, so a later
-- `prisma migrate deploy` applies it again. Every other column of every row is
-- left as it was; when each document row was last written is lost. Idempotent,
-- like the forward migration (#556). The SQLite twin's up -> reverse -> up is
-- tested in server/tests/tool-result-cache-1843.sqlite.test.ts.

DROP INDEX IF EXISTS "documents_projectId_updatedAt_idx";
ALTER TABLE "documents" DROP COLUMN IF EXISTS "updatedAt";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261117001864_issue1864_document_updated_at';
