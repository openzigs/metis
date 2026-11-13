-- Reverse of server/prisma/migrations/20261127002436_issue2436_allow_self_approval
-- (SQLite). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   sqlite3 <db file> < server/prisma/rollbacks/20261127002436_issue2436_allow_self_approval.sql
--
-- Drops "projects"."allowSelfApproval" and forgets the migration, so a later
-- `prisma migrate deploy` applies it again. What is lost: which projects
-- allowed self-approval; after a re-apply every project is back to the strict
-- default (off). The audit log keeps who changed the setting and when. Every
-- other column of every row is untouched.
-- server/tests/allow-self-approval-migration-2436.sqlite.test.ts runs up,
-- this, and up again over a seeded project.

BEGIN;
ALTER TABLE "projects" DROP COLUMN "allowSelfApproval";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261127002436_issue2436_allow_self_approval';
COMMIT;
