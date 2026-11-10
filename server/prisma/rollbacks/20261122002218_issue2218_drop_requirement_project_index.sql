-- Reverse of server/prisma/migrations/20261122002218_issue2218_drop_requirement_project_index
-- (SQLite). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   sqlite3 <db file> < server/prisma/rollbacks/20261122002218_issue2218_drop_requirement_project_index.sql
--
-- Recreates the (`projectId`) index and forgets the migration, so a later
-- `prisma migrate deploy` applies it again. No row is touched.
-- server/tests/requirement-project-index-drop-2218.sqlite.test.ts runs up, this,
-- and up again over a seeded row.

BEGIN;
CREATE INDEX "requirements_projectId_idx" ON "requirements"("projectId");
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261122002218_issue2218_drop_requirement_project_index';
COMMIT;
