-- Reverse of server/prisma/migrations/20261201002566_issue2566_project_code_exploration
-- (SQLite). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   sqlite3 <db file> < server/prisma/rollbacks/20261201002566_issue2566_project_code_exploration.sql
--
-- Drops the column and forgets the migration, so a later
-- `prisma migrate deploy` applies it again. What is lost: each project's code
-- exploration setting; every project then follows the platform key, as `auto`
-- does. Every other column of every row is untouched.
-- server/tests/project-code-exploration-2566.sqlite.test.ts runs up, this, and
-- up again over a seeded project.

BEGIN;
ALTER TABLE "projects" DROP COLUMN "codeExploration";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261201002566_issue2566_project_code_exploration';
COMMIT;
