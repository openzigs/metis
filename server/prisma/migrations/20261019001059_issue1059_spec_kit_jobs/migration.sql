-- Issue #1059 — Spec Kit commands run as background jobs. A command used to be
-- awaited inside the HTTP request that started it, so a `/speckit.plan` longer
-- than the UI proxy's five minutes showed "Internal Server Error" while the
-- server carried on. One row here is one command run: a client polls it, a
-- reloaded page re-attaches to it, and a restarted server finds it.
--
-- `activeKey` is `<projectId>:<featureSlug or empty>` while the job may still
-- write and NULL once it is terminal. Its UNIQUE index is what refuses a second
-- writer of the same artifact set, on any replica (NULLs do not collide).
-- `heartbeatAt` is refreshed by the owning process; a live row whose heartbeat
-- stopped is failed as interrupted by the sweeper. `result` and `error` are
-- JSON text. No foreign key (as "job_scopes"): rows are pruned a day after
-- they finish.
--
-- New, empty table: no backfill. Rollback (documentation):
--   DROP TABLE "spec_kit_jobs";
-- Lossy only for jobs in flight and the last day's job results; the artifacts
-- themselves live in "spec_kit_artifacts" / "spec_kit_feature_artifacts".

-- CreateTable
CREATE TABLE "spec_kit_jobs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "featureSlug" TEXT,
    "activeKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'running',
    "phase" TEXT,
    "result" TEXT,
    "error" TEXT,
    "startedById" TEXT,
    "heartbeatAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME
);

-- CreateIndex
CREATE UNIQUE INDEX "spec_kit_jobs_activeKey_key" ON "spec_kit_jobs"("activeKey");

-- CreateIndex
CREATE INDEX "spec_kit_jobs_projectId_status_idx" ON "spec_kit_jobs"("projectId", "status");

-- CreateIndex
CREATE INDEX "spec_kit_jobs_status_heartbeatAt_idx" ON "spec_kit_jobs"("status", "heartbeatAt");

-- CreateIndex
CREATE INDEX "spec_kit_jobs_finishedAt_idx" ON "spec_kit_jobs"("finishedAt");
