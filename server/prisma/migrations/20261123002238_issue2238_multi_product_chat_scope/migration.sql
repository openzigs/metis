-- Issue #2238 (epic #2228) — multi-product chat: a conversation scoped to a
-- chosen set of projects, or to a workspace, searches all of them every turn.
--
-- 1. "ai_sessions"."scopeProjectIds" (nullable TEXT): a JSON array of the 2+
--    project ids a multi-product session searches. "projectId" stays null for
--    such a session (it binds one project's provider, budget and tools).
-- 2. "ai_sessions"."scopeWorkspaceId" (nullable TEXT, no FK): a session scoped
--    to a workspace; its projects are resolved on every turn.
--
-- Both read null on every existing row, which is exactly what each row was: a
-- session bound to one project or to none. Nothing is backfilled.
--
-- Rollback: server/prisma/rollbacks/20261123002238_issue2238_multi_product_chat_scope.sql
-- (exercised by server/tests/multi-product-chat-scope-migration-2238.sqlite.test.ts).

-- AlterTable
ALTER TABLE "ai_sessions" ADD COLUMN "scopeProjectIds" TEXT;
ALTER TABLE "ai_sessions" ADD COLUMN "scopeWorkspaceId" TEXT;
