-- Reverse of server/prisma/postgres/migrations/20261130002290_issue2290_discussion_message_meta
-- (Postgres). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f server/prisma/postgres/rollbacks/20261130002290_issue2290_discussion_message_meta.sql
--
-- Drops the column and forgets the migration, so a later
-- `prisma migrate deploy` applies it again. What is lost: the checked
-- citations recorded on AI discussion replies; those replies then show no
-- citation list. Idempotent, like the forward migration (#556). The SQLite
-- twin's up -> reverse -> up is tested in
-- server/tests/discussion-message-meta-migration-2290.sqlite.test.ts.

ALTER TABLE "discussion_messages" DROP COLUMN IF EXISTS "meta";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261130002290_issue2290_discussion_message_meta';
