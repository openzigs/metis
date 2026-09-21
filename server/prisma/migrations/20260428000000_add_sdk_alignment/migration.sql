-- Epic #165 — Copilot SDK alignment: customAgents, hooks, plan mode, /model, resume.

-- AlterTable: Project — skill discovery + plan-mode flag
ALTER TABLE "projects" ADD COLUMN "skillDirectories" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "projects" ADD COLUMN "disabledSkills" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "projects" ADD COLUMN "planModeRequired" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable: AISession — mid-session model + plan + snapshot
ALTER TABLE "ai_sessions" ADD COLUMN "currentModel" TEXT;
ALTER TABLE "ai_sessions" ADD COLUMN "currentReasoningEffort" TEXT;
ALTER TABLE "ai_sessions" ADD COLUMN "planModeActive" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ai_sessions" ADD COLUMN "snapshot" TEXT;
ALTER TABLE "ai_sessions" ADD COLUMN "snapshotUpdatedAt" DATETIME;

-- CreateTable: CustomAgent
CREATE TABLE "custom_agents" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "systemPrompt" TEXT NOT NULL DEFAULT '',
    "tools" TEXT NOT NULL DEFAULT '[]',
    "model" TEXT,
    "reasoningEffort" TEXT,
    "isBuiltIn" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "custom_agents_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "custom_agents_projectId_name_key" ON "custom_agents"("projectId", "name");
CREATE INDEX "custom_agents_projectId_idx" ON "custom_agents"("projectId");

-- CreateTable: HookSubscription
CREATE TABLE "hook_subscriptions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "handlerKind" TEXT NOT NULL DEFAULT 'webhook',
    "config" TEXT NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "hook_subscriptions_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "hook_subscriptions_projectId_event_idx" ON "hook_subscriptions"("projectId", "event");
CREATE INDEX "hook_subscriptions_enabled_idx" ON "hook_subscriptions"("enabled");

-- CreateTable: SessionPlan
CREATE TABLE "session_plans" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "planText" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "decidedAt" DATETIME,
    "decidedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "session_plans_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ai_sessions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "session_plans_sessionId_status_idx" ON "session_plans"("sessionId", "status");
