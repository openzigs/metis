-- Reverse of server/prisma/postgres/migrations/20261122002218_issue2218_drop_requirement_project_index
-- (Postgres). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f server/prisma/postgres/rollbacks/20261122002218_issue2218_drop_requirement_project_index.sql
--
-- Recreates the (`projectId`) index and forgets the migration, so a later
-- `prisma migrate deploy` applies it again. No row is touched. Idempotent, like
-- the forward migration (#556). The SQLite twin's up -> reverse -> up is tested
-- in server/tests/requirement-project-index-drop-2218.sqlite.test.ts.

CREATE INDEX IF NOT EXISTS "requirements_projectId_idx" ON "requirements"("projectId");
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261122002218_issue2218_drop_requirement_project_index';
