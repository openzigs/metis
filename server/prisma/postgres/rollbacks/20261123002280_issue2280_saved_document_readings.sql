-- Reverse of server/prisma/postgres/migrations/20261123002280_issue2280_saved_document_readings
-- (Postgres). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f server/prisma/postgres/rollbacks/20261123002280_issue2280_saved_document_readings.sql
--
-- Drops `saved_document_readings` and forgets the migration, so a later
-- `prisma migrate deploy` applies it again. No other table is touched; every
-- saved reading is lost, so each document is read again on its next run.
-- Idempotent, like the forward migration (#556). The SQLite twin's
-- up -> reverse -> up is tested in
-- server/tests/saved-document-reading-migration-2280.sqlite.test.ts.

DROP TABLE IF EXISTS "saved_document_readings";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261123002280_issue2280_saved_document_readings';
