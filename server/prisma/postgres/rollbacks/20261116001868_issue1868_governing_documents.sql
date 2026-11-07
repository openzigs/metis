-- Reverse of server/prisma/postgres/migrations/20261116001868_issue1868_governing_documents
-- (Postgres). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f server/prisma/postgres/rollbacks/20261116001868_issue1868_governing_documents.sql
--
-- Drops the four governing tables and forgets the migration, so a later
-- `prisma migrate deploy` applies it again. No other table is touched; every
-- governing document, revision, rule and rule edit is lost. Idempotent, like
-- the forward migration (#556). `CASCADE` drops the foreign keys the documents
-- and revisions hold on each other. The SQLite twin's up -> reverse -> up is
-- tested in server/tests/governing-documents-migration-1868.sqlite.test.ts.

DROP TABLE IF EXISTS "governing_rule_edits" CASCADE;
DROP TABLE IF EXISTS "governing_rules" CASCADE;
DROP TABLE IF EXISTS "governing_documents" CASCADE;
DROP TABLE IF EXISTS "governing_document_revisions" CASCADE;
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261116001868_issue1868_governing_documents';
