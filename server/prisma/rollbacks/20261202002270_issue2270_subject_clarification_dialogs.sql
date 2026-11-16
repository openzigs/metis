-- Reverse of server/prisma/migrations/20261202002270_issue2270_subject_clarification_dialogs
-- (SQLite). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   sqlite3 <db file> < server/prisma/rollbacks/20261202002270_issue2270_subject_clarification_dialogs.sql
--
-- It drops `subject_clarification_dialogs` and forgets the migration, so a later
-- `prisma migrate deploy` applies it again. No other table is touched. What is
-- lost: every impact run's and portfolio check's clarification dialog (its
-- questions, and answers not yet recorded); the answers already kept as
-- `clarification_records` stay. server/tests/subject-clarification-dialog-migration-2270.sqlite.test.ts
-- runs up, this, and up again over seeded rows.

-- One transaction: if the DELETE failed, the table would be gone while the
-- migration still read as applied, and `migrate deploy` would not recreate it.
BEGIN;
DROP TABLE "subject_clarification_dialogs";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261202002270_issue2270_subject_clarification_dialogs';
COMMIT;
