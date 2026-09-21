-- CreateTable
CREATE TABLE "agent_runs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "projectId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'chat',
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "latencyMs" INTEGER,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "costCents" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'running'
);

-- CreateTable
CREATE TABLE "agent_run_steps" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "ord" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "spanId" TEXT,
    "traceId" TEXT,
    "latencyMs" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "agent_run_steps_runId_fkey" FOREIGN KEY ("runId") REFERENCES "agent_runs" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "known_agent_definitions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'agents-md',
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "systemPrompt" TEXT NOT NULL DEFAULT '',
    "tools" TEXT NOT NULL DEFAULT '[]',
    "model" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "agent_runs_projectId_startedAt_idx" ON "agent_runs"("projectId", "startedAt");

-- CreateIndex
CREATE INDEX "agent_runs_sessionId_startedAt_idx" ON "agent_runs"("sessionId", "startedAt");

-- CreateIndex
CREATE INDEX "agent_runs_status_idx" ON "agent_runs"("status");

-- CreateIndex
CREATE INDEX "agent_run_steps_runId_ord_idx" ON "agent_run_steps"("runId", "ord");

-- CreateIndex
CREATE INDEX "known_agent_definitions_projectId_idx" ON "known_agent_definitions"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "known_agent_definitions_projectId_name_key" ON "known_agent_definitions"("projectId", "name");
