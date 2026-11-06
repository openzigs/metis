-- Reverse of server/prisma/postgres/migrations/20261114001831_issue1831_citation_symbol_identity
-- (Postgres). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f server/prisma/postgres/rollbacks/20261114001831_issue1831_citation_symbol_identity.sql
--
-- Drops the three columns and forgets the migration, so a later `prisma
-- migrate deploy` applies it again. Every other column of every row is left as
-- it was; the cited symbol's identity is lost. Idempotent, like the forward
-- migration (#556). The SQLite twin's up -> reverse -> up is tested in
-- server/tests/citation-revalidation-1831.sqlite.test.ts.

ALTER TABLE "requirement_code_mappings" DROP COLUMN IF EXISTS "symbolContentHash";
ALTER TABLE "requirement_code_mappings" DROP COLUMN IF EXISTS "symbolKind";
ALTER TABLE "requirement_code_mappings" DROP COLUMN IF EXISTS "symbolQualifiedName";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261114001831_issue1831_citation_symbol_identity';
