-- Reverse of server/prisma/migrations/20261123002238_issue2238_multi_product_chat_scope
-- (SQLite). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   sqlite3 <db file> < server/prisma/rollbacks/20261123002238_issue2238_multi_product_chat_scope.sql
--
-- Drops "ai_sessions"."scopeProjectIds" and "scopeWorkspaceId" and forgets the
-- migration, so a later `prisma migrate deploy` applies it again. What is lost:
-- the scope of every multi-product and workspace chat. Those sessions keep
-- their transcript and read as unscoped ("All projects") chats afterwards.
-- Every other column of every row is untouched.
-- server/tests/multi-product-chat-scope-migration-2238.sqlite.test.ts runs up,
-- this, and up again over a seeded row.

BEGIN;
ALTER TABLE "ai_sessions" DROP COLUMN "scopeWorkspaceId";
ALTER TABLE "ai_sessions" DROP COLUMN "scopeProjectIds";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261123002238_issue2238_multi_product_chat_scope';
COMMIT;
