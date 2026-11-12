-- Reverse of server/prisma/migrations/20261123002280_issue2280_saved_document_readings
-- (SQLite). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   sqlite3 <db file> < server/prisma/rollbacks/20261123002280_issue2280_saved_document_readings.sql
--
-- It drops `saved_document_readings` and forgets the migration, so a later
-- `prisma migrate deploy` applies it again. No other table is touched. What is
-- lost: every saved reading, so the next run of each document reads it again
-- (and pays for it). server/tests/saved-document-reading-migration-2280.sqlite.test.ts
-- runs up, this, and up again over seeded rows.

-- One transaction: if the DELETE failed, the table would be gone while the
-- migration still read as applied, and `migrate deploy` would not recreate it.
BEGIN;
DROP TABLE "saved_document_readings";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261123002280_issue2280_saved_document_readings';
COMMIT;
