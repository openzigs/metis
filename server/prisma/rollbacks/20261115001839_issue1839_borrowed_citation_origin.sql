-- Reverse of server/prisma/migrations/20261115001839_issue1839_borrowed_citation_origin
-- (SQLite). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   sqlite3 <db file> < server/prisma/rollbacks/20261115001839_issue1839_borrowed_citation_origin.sql
--
-- Drops the column (SQLite 3.35+; it is not indexed or constrained) and
-- forgets the migration, so a later `prisma migrate deploy` applies it again.
-- Every other column of every row is left as it was. What is lost: which
-- requirement a borrowed link came from; the rows keep their
-- `similar-requirement` source, so they still read as borrowed.
-- server/tests/borrow-citations-1839.sqlite.test.ts runs up, this, and up again
-- over a seeded row.

-- One transaction: if the DELETE failed, the column would be gone while the
-- migration still read as applied, and `migrate deploy` would not re-add it.
BEGIN;
ALTER TABLE "requirement_code_mappings" DROP COLUMN "originRequirementId";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261115001839_issue1839_borrowed_citation_origin';
COMMIT;
