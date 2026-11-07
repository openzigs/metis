-- Reverse of server/prisma/migrations/20261116001868_issue1868_governing_documents
-- (SQLite). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   sqlite3 <db file> < server/prisma/rollbacks/20261116001868_issue1868_governing_documents.sql
--
-- It drops the four governing tables and forgets the migration, so a later
-- `prisma migrate deploy` applies it again. No other table is touched. What is
-- lost: every governing document, revision, extracted rule and rule edit (the
-- uploaded files under each revision's `storagePath` are not removed).
-- server/tests/governing-documents-migration-1868.sqlite.test.ts runs up, this,
-- and up again over seeded rows.

-- One transaction: if the DELETE failed, the tables would be gone while the
-- migration still read as applied, and `migrate deploy` would not recreate them.
-- Children first, so the drops hold with `foreign_keys` on as well as off.
BEGIN;
DROP TABLE "governing_rule_edits";
DROP TABLE "governing_rules";
DROP TABLE "governing_documents";
DROP TABLE "governing_document_revisions";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261116001868_issue1868_governing_documents';
COMMIT;
