-- Reverse of server/prisma/postgres/migrations/20261120001558_issue1558_audit_action_ts_index
-- (Postgres). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f server/prisma/postgres/rollbacks/20261120001558_issue1558_audit_action_ts_index.sql
--
-- Drops the index and forgets the migration, so a later `prisma migrate deploy`
-- applies it again. No row is touched. Idempotent, like the forward migration
-- (#556). The SQLite twin's up -> reverse -> up is tested in
-- server/tests/audit-action-ts-index-migration-1558.sqlite.test.ts.

DROP INDEX IF EXISTS "audit_logs_action_ts_idx";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261120001558_issue1558_audit_action_ts_index';
