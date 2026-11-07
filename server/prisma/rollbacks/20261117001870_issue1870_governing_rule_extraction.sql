-- Reverse of server/prisma/migrations/20261117001870_issue1870_governing_rule_extraction
-- (SQLite). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   sqlite3 <db file> < server/prisma/rollbacks/20261117001870_issue1870_governing_rule_extraction.sql
--
-- Drops the two columns (SQLite 3.35+; neither is indexed or constrained) and
-- forgets the migration, so a later `prisma migrate deploy` applies it again.
-- Every other column of every row is left as it was. What is lost: why a
-- revision's extraction failed and how many rules it dropped; the rules
-- themselves and `extractionState` stay.
-- server/tests/governing-rule-extraction-migration-1870.sqlite.test.ts runs up,
-- this, and up again over a seeded row.

-- One transaction: if the DELETE failed, the columns would be gone while the
-- migration still read as applied, and `migrate deploy` would not re-add them.
BEGIN;
ALTER TABLE "governing_document_revisions" DROP COLUMN "droppedUnverified";
ALTER TABLE "governing_document_revisions" DROP COLUMN "extractionError";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261117001870_issue1870_governing_rule_extraction';
COMMIT;
