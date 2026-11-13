-- Reverse of server/prisma/postgres/migrations/20261127002436_issue2436_allow_self_approval
-- (Postgres). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f server/prisma/postgres/rollbacks/20261127002436_issue2436_allow_self_approval.sql
--
-- Drops "projects"."allowSelfApproval" and forgets the migration, so a later
-- `prisma migrate deploy` applies it again. What is lost: which projects
-- allowed self-approval; after a re-apply every project is back to the strict
-- default (off). Idempotent, like the forward migration (#556). The SQLite
-- twin's up -> reverse -> up is tested in
-- server/tests/allow-self-approval-migration-2436.sqlite.test.ts.

ALTER TABLE "projects" DROP COLUMN IF EXISTS "allowSelfApproval";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261127002436_issue2436_allow_self_approval';
