-- Reverse of server/prisma/postgres/migrations/20261119001874_issue1874_governing_findings
-- (Postgres). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f server/prisma/postgres/rollbacks/20261119001874_issue1874_governing_findings.sql
--
-- Drops the governing findings table and forgets the migration, so a later
-- `prisma migrate deploy` applies it again. No other table is touched; every
-- governing finding and its BA decision is lost (each decision's `audit_logs`
-- row stays). Idempotent, like the forward migration (#556). The SQLite twin's
-- up -> reverse -> up is tested in server/tests/governing-findings-migration-1874.sqlite.test.ts.

DROP TABLE IF EXISTS "governing_findings" CASCADE;
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261119001874_issue1874_governing_findings';
