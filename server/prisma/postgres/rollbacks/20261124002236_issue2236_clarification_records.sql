-- Reverse of server/prisma/postgres/migrations/20261124002236_issue2236_clarification_records
-- (Postgres). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f server/prisma/postgres/rollbacks/20261124002236_issue2236_clarification_records.sql
--
-- Drops the clarification records table and forgets the migration, so a later
-- `prisma migrate deploy` applies it again. No other table is touched; every
-- stored clarification record is lost (the answers stay in each analysis's
-- dialog state). Idempotent, like the forward migration (#556). The SQLite
-- twin's up -> reverse -> up is tested in
-- server/tests/clarification-records-migration-2236.sqlite.test.ts.

DROP TABLE IF EXISTS "clarification_records" CASCADE;
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261124002236_issue2236_clarification_records';
