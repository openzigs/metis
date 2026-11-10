-- Reverse of server/prisma/migrations/20261121002209_issue2209_requirement_picker_index
-- (SQLite). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   sqlite3 <db file> < server/prisma/rollbacks/20261121002209_issue2209_requirement_picker_index.sql
--
-- Drops the index and forgets the migration, so a later `prisma migrate deploy`
-- applies it again. No row is touched; the requirement picker's reads go back to
-- sorting the project's requirements. server/tests/requirement-picker-index-migration-2209.sqlite.test.ts
-- runs up, this, and up again over a seeded row.

BEGIN;
DROP INDEX "requirements_projectId_createdAt_id_idx";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261121002209_issue2209_requirement_picker_index';
COMMIT;
