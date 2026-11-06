-- Reverse of server/prisma/postgres/migrations/20261113001830_issue1830_code_citation_freshness
-- (Postgres). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f server/prisma/postgres/rollbacks/20261113001830_issue1830_code_citation_freshness.sql
--
-- Drops the foreign key, the index and the eight #1830 columns, and forgets
-- the migration, so a later `prisma migrate deploy` applies it again. Every
-- pre-existing column of every row is left as it was; each citation's graph,
-- commit and freshness verdict are lost. Idempotent, like the forward
-- migration (#556). The SQLite twin's up -> reverse -> up is tested in
-- server/tests/code-citation-freshness-migration-1830.sqlite.test.ts.

ALTER TABLE "requirement_code_mappings" DROP CONSTRAINT IF EXISTS "requirement_code_mappings_codeGraphId_fkey";
DROP INDEX IF EXISTS "requirement_code_mappings_codeGraphId_idx";
ALTER TABLE "requirement_code_mappings" DROP COLUMN IF EXISTS "codeGraphId";
ALTER TABLE "requirement_code_mappings" DROP COLUMN IF EXISTS "commitSha";
ALTER TABLE "requirement_code_mappings" DROP COLUMN IF EXISTS "freshness";
ALTER TABLE "requirement_code_mappings" DROP COLUMN IF EXISTS "validatedAt";
ALTER TABLE "requirement_code_mappings" DROP COLUMN IF EXISTS "previousFilePath";
ALTER TABLE "requirement_code_mappings" DROP COLUMN IF EXISTS "previousStartLine";
ALTER TABLE "requirement_code_mappings" DROP COLUMN IF EXISTS "previousEndLine";
ALTER TABLE "requirement_code_mappings" DROP COLUMN IF EXISTS "staleReason";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261113001830_issue1830_code_citation_freshness';
