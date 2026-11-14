-- Reverse of server/prisma/migrations/20261130002290_issue2290_discussion_message_meta
-- (SQLite). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   sqlite3 <db file> < server/prisma/rollbacks/20261130002290_issue2290_discussion_message_meta.sql
--
-- Drops the column and forgets the migration, so a later
-- `prisma migrate deploy` applies it again. What is lost: the checked
-- citations recorded on AI discussion replies; those replies then show no
-- citation list. Every other column of every row is untouched.
-- server/tests/discussion-message-meta-migration-2290.sqlite.test.ts runs up,
-- this, and up again over seeded rows.

BEGIN;
ALTER TABLE "discussion_messages" DROP COLUMN "meta";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261130002290_issue2290_discussion_message_meta';
COMMIT;
