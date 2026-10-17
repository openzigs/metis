-- Issue #1235 — a scheduled webhook may send only a vault secret its binder may use.
-- Postgres twin of `server/prisma/migrations/20261022001235_issue1235_webhook_binder`;
-- the reasoning and the rollback are written there. Idempotent.
--
-- Nullable TEXT / TIMESTAMP columns: a metadata-only change on Postgres 11+, with
-- no table rewrite. The index is built in place; `audit_logs` is append-only.
ALTER TABLE "scheduled_jobs" ADD COLUMN IF NOT EXISTS "webhookBinderId" TEXT;

ALTER TABLE "scheduled_jobs" ADD COLUMN IF NOT EXISTS "webhookBoundAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "audit_logs_targetType_targetId_action_idx" ON "audit_logs"("targetType", "targetId", "action");
