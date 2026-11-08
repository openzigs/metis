-- Reverse of server/prisma/migrations/20261119001874_issue1874_governing_findings
-- (SQLite). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   sqlite3 <db file> < server/prisma/rollbacks/20261119001874_issue1874_governing_findings.sql
--
-- It drops the governing findings table and forgets the migration, so a later
-- `prisma migrate deploy` applies it again. No other table is touched. What is
-- lost: every governing finding and the BA decision on it (each decision's
-- `audit_logs` row stays). server/tests/governing-findings-migration-1874.sqlite.test.ts
-- runs up, this, and up again over seeded rows.

-- One transaction: if the DELETE failed, the table would be gone while the
-- migration still read as applied, and `migrate deploy` would not recreate it.
BEGIN;
DROP TABLE "governing_findings";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261119001874_issue1874_governing_findings';
COMMIT;
