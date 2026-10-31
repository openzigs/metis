-- Reverse of server/prisma/migrations/20261105001612_issue1612_requirement_kind
-- (SQLite). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   sqlite3 <db file> < server/prisma/rollbacks/20261105001612_issue1612_requirement_kind.sql
--
-- It drops the two columns (SQLite 3.35+; neither is indexed or constrained)
-- and forgets the migration, so a later `prisma migrate deploy` applies it
-- again. Every other column of every row is left as it was. What an analyst set
-- in `kind` / `nfrCategory` is lost: it is stored nowhere else.
-- server/tests/requirement-kind-migration-1612.sqlite.test.ts runs up, this,
-- and up again over seeded rows.

-- One transaction: if the DELETE failed, the columns would be gone while the
-- migration still read as applied, and `migrate deploy` would not re-add them.
BEGIN;
ALTER TABLE "requirements" DROP COLUMN "nfrCategory";
ALTER TABLE "requirements" DROP COLUMN "kind";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261105001612_issue1612_requirement_kind';
COMMIT;
