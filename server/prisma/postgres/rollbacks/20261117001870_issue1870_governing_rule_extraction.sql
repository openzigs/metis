-- Reverse of server/prisma/postgres/migrations/20261117001870_issue1870_governing_rule_extraction
-- (Postgres). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f server/prisma/postgres/rollbacks/20261117001870_issue1870_governing_rule_extraction.sql
--
-- Drops the two columns and forgets the migration, so a later `prisma migrate
-- deploy` applies it again. Every other column of every row is left as it was;
-- why an extraction failed and how many rules it dropped are lost. Idempotent,
-- like the forward migration (#556). The SQLite twin's up -> reverse -> up is
-- tested in server/tests/governing-rule-extraction-migration-1870.sqlite.test.ts.

ALTER TABLE "governing_document_revisions" DROP COLUMN IF EXISTS "droppedUnverified";
ALTER TABLE "governing_document_revisions" DROP COLUMN IF EXISTS "extractionError";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261117001870_issue1870_governing_rule_extraction';
