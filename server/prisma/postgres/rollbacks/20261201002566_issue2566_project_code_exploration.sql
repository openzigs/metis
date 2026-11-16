-- Reverse of server/prisma/postgres/migrations/20261201002566_issue2566_project_code_exploration
-- (Postgres). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f server/prisma/postgres/rollbacks/20261201002566_issue2566_project_code_exploration.sql
--
-- Drops the column and forgets the migration, so a later
-- `prisma migrate deploy` applies it again. What is lost: each project's code
-- exploration setting; every project then follows the platform key, as `auto`
-- does. Idempotent, like the forward migration (#556). The postgres-migrate-deploy
-- CI job applies up -> this -> up over a seeded project; the SQLite twin's
-- round trip is in server/tests/project-code-exploration-2566.sqlite.test.ts.

ALTER TABLE "projects" DROP COLUMN IF EXISTS "codeExploration";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261201002566_issue2566_project_code_exploration';
