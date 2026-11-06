-- Reverse of server/prisma/migrations/20261114001831_issue1831_citation_symbol_identity
-- (SQLite). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   sqlite3 <db file> < server/prisma/rollbacks/20261114001831_issue1831_citation_symbol_identity.sql
--
-- Drops the three columns (SQLite 3.35+; none is indexed or constrained) and
-- forgets the migration, so a later `prisma migrate deploy` applies it again.
-- Every other column of every row is left as it was. What is lost: the cited
-- symbol's identity, so a link whose symbol row an ingest deleted can no
-- longer be followed and re-validates as a file-level link.
-- server/tests/citation-revalidation-1831.sqlite.test.ts runs up, this, and up
-- again over a seeded row.

-- One transaction: if the DELETE failed, the columns would be gone while the
-- migration still read as applied, and `migrate deploy` would not re-add them.
BEGIN;
ALTER TABLE "requirement_code_mappings" DROP COLUMN "symbolContentHash";
ALTER TABLE "requirement_code_mappings" DROP COLUMN "symbolKind";
ALTER TABLE "requirement_code_mappings" DROP COLUMN "symbolQualifiedName";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261114001831_issue1831_citation_symbol_identity';
COMMIT;
