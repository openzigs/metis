-- Issue #1245 — a scheduled-job edit cannot silently undo a concurrent one.
-- Postgres twin of `server/prisma/migrations/20261024001245_issue1245_scheduled_job_version`;
-- the reasoning and the rollback are written there. Idempotent.
--
-- NOT NULL with a constant default: a metadata-only change on Postgres 11+, with
-- no table rewrite.
ALTER TABLE "scheduled_jobs" ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 0;
