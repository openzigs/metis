-- Reverse of server/prisma/migrations/20261113001835_issue1835_requirement_embeddings
-- (SQLite). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   sqlite3 <db file> < server/prisma/rollbacks/20261113001835_issue1835_requirement_embeddings.sql
--
-- It drops `requirement_embeddings` and forgets the migration, so a later
-- `prisma migrate deploy` applies it again. No other table is touched. What is
-- lost: the hash bookkeeping only. The vectors in `<projectId>__requirements`
-- stay where they are and the next reconcile re-embeds every requirement once
-- (it finds no hash to compare). server/tests/requirement-embedding-migration-1835.sqlite.test.ts
-- runs up, this, and up again over seeded rows.

-- One transaction: if the DELETE failed, the table would be gone while the
-- migration still read as applied, and `migrate deploy` would not recreate it.
BEGIN;
DROP TABLE "requirement_embeddings";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261113001835_issue1835_requirement_embeddings';
COMMIT;
