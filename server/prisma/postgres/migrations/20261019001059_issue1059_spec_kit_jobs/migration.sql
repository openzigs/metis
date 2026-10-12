-- Issue #1059 — Spec Kit commands run as background jobs (Postgres mirror). See
-- the SQLite migration of the same name for the full rationale: one row is one
-- command run, polled by the client, re-attached to after a reload and found by
-- a restarted server.
--
-- `activeKey` is `<projectId>:<featureSlug or empty>` while the job may still
-- write and NULL once it is terminal; its UNIQUE index refuses a second writer
-- of the same artifact set on any replica (NULLs do not collide). No foreign
-- key (as "job_scopes"): rows are pruned a day after they finish.
--
-- All DDL is idempotent (`IF NOT EXISTS`) so the full history replays cleanly
-- over the cumulative `00000000000000_init` baseline on a fresh Postgres
-- (issue #556 guard).
--
-- New, empty table: no backfill. Rollback (documentation):
--   DROP TABLE "spec_kit_jobs";
-- Lossy only for jobs in flight and the last day's job results.

-- CreateTable
CREATE TABLE IF NOT EXISTS "spec_kit_jobs" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "featureSlug" TEXT,
    "activeKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'running',
    "phase" TEXT,
    "result" TEXT,
    "error" TEXT,
    "startedById" TEXT,
    "heartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "spec_kit_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "spec_kit_jobs_activeKey_key" ON "spec_kit_jobs"("activeKey");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "spec_kit_jobs_projectId_status_idx" ON "spec_kit_jobs"("projectId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "spec_kit_jobs_status_heartbeatAt_idx" ON "spec_kit_jobs"("status", "heartbeatAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "spec_kit_jobs_finishedAt_idx" ON "spec_kit_jobs"("finishedAt");
