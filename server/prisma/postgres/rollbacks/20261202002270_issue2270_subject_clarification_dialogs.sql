-- Reverse of server/prisma/postgres/migrations/20261202002270_issue2270_subject_clarification_dialogs
-- (Postgres). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f server/prisma/postgres/rollbacks/20261202002270_issue2270_subject_clarification_dialogs.sql
--
-- Drops `subject_clarification_dialogs` and forgets the migration, so a later
-- `prisma migrate deploy` applies it again. No other table is touched; every
-- impact run's and portfolio check's dialog is lost (answers already kept as
-- `clarification_records` stay). Idempotent, like the forward migration (#556).
-- The SQLite twin's up -> reverse -> up is tested in
-- server/tests/subject-clarification-dialog-migration-2270.sqlite.test.ts.

DROP TABLE IF EXISTS "subject_clarification_dialogs";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261202002270_issue2270_subject_clarification_dialogs';
