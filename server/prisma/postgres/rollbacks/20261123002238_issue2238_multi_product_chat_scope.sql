-- Reverse of server/prisma/postgres/migrations/20261123002238_issue2238_multi_product_chat_scope
-- (Postgres). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f server/prisma/postgres/rollbacks/20261123002238_issue2238_multi_product_chat_scope.sql
--
-- Drops "ai_sessions"."scopeProjectIds" and "scopeWorkspaceId" and forgets the
-- migration, so a later `prisma migrate deploy` applies it again. What is lost:
-- the scope of every multi-product and workspace chat (they read as unscoped
-- afterwards). Idempotent, like the forward migration (#556). The SQLite twin's
-- up -> reverse -> up is tested in
-- server/tests/multi-product-chat-scope-migration-2238.sqlite.test.ts.

ALTER TABLE "ai_sessions" DROP COLUMN IF EXISTS "scopeWorkspaceId";
ALTER TABLE "ai_sessions" DROP COLUMN IF EXISTS "scopeProjectIds";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261123002238_issue2238_multi_product_chat_scope';
