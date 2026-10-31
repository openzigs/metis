-- Reverse of server/prisma/postgres/migrations/20261105001612_issue1612_requirement_kind
-- (Postgres). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f server/prisma/postgres/rollbacks/20261105001612_issue1612_requirement_kind.sql
--
-- Drops the two columns and forgets the migration, so a later
-- `prisma migrate deploy` applies it again. Every other column of every row is
-- left as it was; `kind` / `nfrCategory` values are lost. Idempotent, like the
-- forward migration (#556). The SQLite twin's up -> reverse -> up is tested in
-- server/tests/requirement-kind-migration-1612.sqlite.test.ts.

ALTER TABLE "requirements" DROP COLUMN IF EXISTS "nfrCategory";
ALTER TABLE "requirements" DROP COLUMN IF EXISTS "kind";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261105001612_issue1612_requirement_kind';
