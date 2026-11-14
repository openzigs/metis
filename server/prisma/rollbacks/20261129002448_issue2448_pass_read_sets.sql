-- Reverse of server/prisma/migrations/20261129002448_issue2448_pass_read_sets
-- (SQLite). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   sqlite3 <db file> < server/prisma/rollbacks/20261129002448_issue2448_pass_read_sets.sql
--
-- Drops the column and forgets the migration, so a later
-- `prisma migrate deploy` applies it again. What is lost: what each pass of a
-- `starter` run read. Those runs then fail closed: what rests on one as a
-- whole (its requirements, an agent's summary) is shown only to a reader who
-- can see every document of its project. Every other column of every row is
-- untouched.
-- server/tests/pass-read-sets-migration-2448.sqlite.test.ts runs up, this,
-- and up again over seeded rows.

BEGIN;
ALTER TABLE "agent_results" DROP COLUMN "readSourceIds";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261129002448_issue2448_pass_read_sets';
COMMIT;
