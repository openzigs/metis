-- Epic #194 — Eval & Bench (v1.2.0).
--
-- Adds the BenchRun + BenchTaskResult models that store nightly benchmark
-- results (SWE-bench-Pro and TAU-bench) for the leaderboard endpoint.
--
--   * BenchRun           — one per benchmark execution (e.g. nightly cron run).
--   * BenchTaskResult    — per-task pass/fail detail powering the diff viewer.

CREATE TABLE "bench_runs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "benchmark" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "score" REAL NOT NULL DEFAULT 0,
    "totalTasks" INTEGER NOT NULL DEFAULT 0,
    "passedTasks" INTEGER NOT NULL DEFAULT 0,
    "meanTokens" INTEGER NOT NULL DEFAULT 0,
    "meanCostCents" INTEGER NOT NULL DEFAULT 0,
    "meanLatencyMs" INTEGER NOT NULL DEFAULT 0,
    "startedAt" DATETIME NOT NULL,
    "completedAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'running',
    "metadata" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "bench_runs_benchmark_startedAt_idx" ON "bench_runs"("benchmark", "startedAt");
CREATE INDEX "bench_runs_status_idx" ON "bench_runs"("status");

CREATE TABLE "bench_task_results" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "benchRunId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "passed" BOOLEAN NOT NULL DEFAULT false,
    "score" REAL NOT NULL DEFAULT 0,
    "tokens" INTEGER NOT NULL DEFAULT 0,
    "costCents" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "expected" TEXT,
    "actual" TEXT,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "bench_task_results_benchRunId_fkey" FOREIGN KEY ("benchRunId") REFERENCES "bench_runs" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "bench_task_results_benchRunId_idx" ON "bench_task_results"("benchRunId");
CREATE INDEX "bench_task_results_taskId_idx" ON "bench_task_results"("taskId");
