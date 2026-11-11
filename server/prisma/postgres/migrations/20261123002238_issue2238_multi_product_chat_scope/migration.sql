-- Issue #2238 (epic #2228) — multi-product chat scope (Postgres twin of
-- server/prisma/migrations/20261123002238_issue2238_multi_product_chat_scope;
-- see that file for the rationale). Nothing backfilled. Idempotent (#556).
--
-- Rollback: server/prisma/postgres/rollbacks/20261123002238_issue2238_multi_product_chat_scope.sql

ALTER TABLE "ai_sessions" ADD COLUMN IF NOT EXISTS "scopeProjectIds" TEXT;
ALTER TABLE "ai_sessions" ADD COLUMN IF NOT EXISTS "scopeWorkspaceId" TEXT;
