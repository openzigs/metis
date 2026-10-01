-- Issue #674 — a durable record of the scope of a job id that names no row
-- (Postgres mirror). See the SQLite migration of the same name for the full
-- rationale: `subscribe:job` could not authorize a row-less job (repo ingest,
-- spec-kit, overview regenerate, embeddings reindex, PR review) on another
-- cluster replica, after a restart, or after in-process eviction.
--
-- All DDL is idempotent (`IF NOT EXISTS`) so the full history replays cleanly
-- over the cumulative `00000000000000_init` baseline on a fresh Postgres
-- (issue #556 guard).
--
-- Rollback (documentation): `DROP TABLE "job_scopes";`. Lossy only for jobs
-- in flight: their subscribers fall back to the in-process scope store.

-- CreateTable
CREATE TABLE IF NOT EXISTS "job_scopes" (
    "jobId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "projectId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_scopes_pkey" PRIMARY KEY ("jobId")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "job_scopes_expiresAt_idx" ON "job_scopes"("expiresAt");
