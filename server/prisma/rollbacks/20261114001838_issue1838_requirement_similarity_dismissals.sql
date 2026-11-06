-- Reverse of server/prisma/migrations/20261114001838_issue1838_requirement_similarity_dismissals
-- (SQLite). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   sqlite3 <db file> < server/prisma/rollbacks/20261114001838_issue1838_requirement_similarity_dismissals.sql
--
-- It drops `requirement_similarity_dismissals` and forgets the migration, so a
-- later `prisma migrate deploy` applies it again. No other table is touched.
-- What is lost: every "Not a duplicate" answer, so those duplicate warnings
-- show again. server/tests/requirement-similarity-dismissal-migration-1838.sqlite.test.ts
-- runs up, this, and up again over seeded rows.

-- One transaction: if the DELETE failed, the table would be gone while the
-- migration still read as applied, and `migrate deploy` would not recreate it.
BEGIN;
DROP TABLE "requirement_similarity_dismissals";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261114001838_issue1838_requirement_similarity_dismissals';
COMMIT;
