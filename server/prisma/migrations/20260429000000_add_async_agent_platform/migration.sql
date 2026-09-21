-- Epic #156 — Async agent platform: background runs, triggers, best-of-N, mid-run steering, compaction.

-- AlterTable: Project — context compaction threshold
ALTER TABLE "projects" ADD COLUMN "contextCompactionThreshold" INTEGER;

-- AlterTable: AISession — compaction bookkeeping
ALTER TABLE "ai_sessions" ADD COLUMN "lastCompactedAt" DATETIME;
ALTER TABLE "ai_sessions" ADD COLUMN "compactionCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable: BackgroundRun
CREATE TABLE "background_runs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "sessionId" TEXT,
    "kind" TEXT NOT NULL,
    "payload" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "runGroupId" TEXT,
    "heartbeatAt" DATETIME,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "error" TEXT,
    "result" TEXT,
    "score" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "background_runs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "background_runs_runGroupId_fkey" FOREIGN KEY ("runGroupId") REFERENCES "run_groups" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "background_runs_projectId_status_idx" ON "background_runs"("projectId", "status");
CREATE INDEX "background_runs_status_priority_idx" ON "background_runs"("status", "priority");
CREATE INDEX "background_runs_runGroupId_idx" ON "background_runs"("runGroupId");

-- CreateTable: Trigger
CREATE TABLE "triggers" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "config" TEXT NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastFiredAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "triggers_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "triggers_projectId_source_idx" ON "triggers"("projectId", "source");
CREATE INDEX "triggers_enabled_idx" ON "triggers"("enabled");

-- CreateTable: RunGroup
CREATE TABLE "run_groups" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "parentRunId" TEXT,
    "n" INTEGER NOT NULL DEFAULT 1,
    "strategy" TEXT NOT NULL DEFAULT 'best-of-n',
    "selectionMethod" TEXT NOT NULL DEFAULT 'highest-score',
    "winnerRunId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "run_groups_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "run_groups_projectId_status_idx" ON "run_groups"("projectId", "status");

-- CreateTable: RunMessage
CREATE TABLE "run_messages" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "ord" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" DATETIME,
    CONSTRAINT "run_messages_runId_fkey" FOREIGN KEY ("runId") REFERENCES "background_runs" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "run_messages_runId_ord_idx" ON "run_messages"("runId", "ord");
CREATE INDEX "run_messages_runId_status_idx" ON "run_messages"("runId", "status");
