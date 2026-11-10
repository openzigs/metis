-- Reverse of server/prisma/migrations/20261120001558_issue1558_audit_action_ts_index
-- (SQLite). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   sqlite3 <db file> < server/prisma/rollbacks/20261120001558_issue1558_audit_action_ts_index.sql
--
-- Drops the index and forgets the migration, so a later `prisma migrate deploy`
-- applies it again. No row is touched; the admin SAML warnings' reads go back to
-- scanning the audit table. server/tests/audit-action-ts-index-migration-1558.sqlite.test.ts
-- runs up, this, and up again over a seeded row.

BEGIN;
DROP INDEX "audit_logs_action_ts_idx";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261120001558_issue1558_audit_action_ts_index';
COMMIT;
