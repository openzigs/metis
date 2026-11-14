-- Reverse of server/prisma/postgres/migrations/20261129002448_issue2448_pass_read_sets
-- (Postgres). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f server/prisma/postgres/rollbacks/20261129002448_issue2448_pass_read_sets.sql
--
-- Drops the column and forgets the migration, so a later
-- `prisma migrate deploy` applies it again. What is lost: what each pass of a
-- `starter` run read. Those runs then fail closed: what rests on one as a
-- whole is shown only to a reader who can see every document of its project.
-- Idempotent, like the forward migration (#556). The SQLite twin's
-- up -> reverse -> up is tested in
-- server/tests/pass-read-sets-migration-2448.sqlite.test.ts.

ALTER TABLE "agent_results" DROP COLUMN IF EXISTS "readSourceIds";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261129002448_issue2448_pass_read_sets';
