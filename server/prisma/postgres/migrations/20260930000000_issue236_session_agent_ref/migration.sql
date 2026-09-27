-- Issue #236 — a chat session's own agent may be a project CUSTOM agent
-- (Postgres mirror). See the SQLite migration of the same name for the full
-- rationale. `IF NOT EXISTS` keeps the full chain idempotent (issue #556).
ALTER TABLE "ai_sessions" ADD COLUMN IF NOT EXISTS "agentRef" TEXT;
