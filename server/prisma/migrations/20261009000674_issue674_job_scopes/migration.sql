-- Issue #674 — a durable record of the scope of a job id that names no row.
--
-- `subscribe:job` (#655) authorizes a `job:{id}` join against the job's kind
-- and project. Jobs with a row (analysis, generated document, import run,
-- impact analysis) are scoped from it; the rest (repo ingest, spec-kit,
-- overview regenerate, embeddings reindex, PR review) were scoped only from
-- process memory, so on another cluster replica, after a restart, or once the
-- 500-entry in-process store evicted the id, the job's own initiator was
-- refused. `job_scopes` is written before the job id is handed to the client,
-- read by `subscribe:job` when this process remembers nothing, and pruned of
-- rows past `expiresAt` on each write.
--
-- Additive only: a new table, no existing column changes, nothing backfilled
-- (a job started before this migration keeps the pre-#674 behaviour).
--
-- Rollback (documentation): `DROP TABLE "job_scopes";`. Lossy only for jobs
-- in flight: their subscribers fall back to the in-process scope store.

-- CreateTable
CREATE TABLE "job_scopes" (
    "jobId" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "projectId" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "job_scopes_expiresAt_idx" ON "job_scopes"("expiresAt");
