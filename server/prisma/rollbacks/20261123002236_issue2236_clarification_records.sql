-- Reverse of server/prisma/migrations/20261123002236_issue2236_clarification_records
-- (SQLite). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   sqlite3 <db file> < server/prisma/rollbacks/20261123002236_issue2236_clarification_records.sql
--
-- It drops the clarification records table and forgets the migration, so a
-- later `prisma migrate deploy` applies it again. No other table is touched.
-- What is lost: every stored clarification record. The answers themselves
-- stay in each analysis's dialog state, and the indexed answer documents stay
-- in `documents` (delete them from the project's documents if unwanted).
-- server/tests/clarification-records-migration-2236.sqlite.test.ts runs up,
-- this, and up again over seeded rows.

-- One transaction: if the DELETE failed, the table would be gone while the
-- migration still read as applied, and `migrate deploy` would not recreate it.
BEGIN;
DROP TABLE "clarification_records";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261123002236_issue2236_clarification_records';
COMMIT;
