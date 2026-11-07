-- Reverse of server/prisma/migrations/20261117001864_issue1864_document_updated_at
-- (SQLite). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   sqlite3 <db file> < server/prisma/rollbacks/20261117001864_issue1864_document_updated_at.sql
--
-- Drops the index, then the column (SQLite refuses to drop an indexed column),
-- and forgets the migration, so a later `prisma migrate deploy` applies it
-- again. Every other column of every row is left as it was. What is lost: when
-- each document row was last written; nothing else reads it.
-- server/tests/tool-result-cache-1843.sqlite.test.ts runs up, this, and up
-- again over a seeded row.

-- One transaction: if the DELETE failed, the column would be gone while the
-- migration still read as applied, and `migrate deploy` would not re-add it.
BEGIN;
DROP INDEX "documents_projectId_updatedAt_idx";
ALTER TABLE "documents" DROP COLUMN "updatedAt";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261117001864_issue1864_document_updated_at';
COMMIT;
