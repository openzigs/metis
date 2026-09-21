-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_scheduled_jobs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cron" TEXT NOT NULL,
    "taskType" TEXT NOT NULL DEFAULT 'http-webhook',
    "payload" TEXT NOT NULL DEFAULT '{}',
    "projectId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" DATETIME,
    "nextRunAt" DATETIME,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "scheduled_jobs_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_scheduled_jobs" ("createdAt", "createdById", "cron", "deletedAt", "enabled", "id", "key", "lastRunAt", "name", "nextRunAt", "payload", "updatedAt") SELECT "createdAt", "createdById", "cron", "deletedAt", "enabled", "id", "key", "lastRunAt", "name", "nextRunAt", "payload", "updatedAt" FROM "scheduled_jobs";
DROP TABLE "scheduled_jobs";
ALTER TABLE "new_scheduled_jobs" RENAME TO "scheduled_jobs";
CREATE UNIQUE INDEX "scheduled_jobs_key_key" ON "scheduled_jobs"("key");
CREATE INDEX "scheduled_jobs_enabled_nextRunAt_idx" ON "scheduled_jobs"("enabled", "nextRunAt");
CREATE INDEX "scheduled_jobs_projectId_idx" ON "scheduled_jobs"("projectId");
CREATE TABLE "new_tasks" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scheduledJobId" TEXT,
    "projectId" TEXT,
    "type" TEXT NOT NULL,
    "trigger" TEXT NOT NULL DEFAULT 'manual',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "priority" INTEGER NOT NULL DEFAULT 5,
    "payload" TEXT NOT NULL DEFAULT '{}',
    "result" TEXT,
    "errorMessage" TEXT,
    "progress" INTEGER,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "scheduledFor" DATETIME,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "tasks_scheduledJobId_fkey" FOREIGN KEY ("scheduledJobId") REFERENCES "scheduled_jobs" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "tasks_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_tasks" ("attempts", "completedAt", "createdAt", "createdById", "errorMessage", "id", "maxAttempts", "payload", "priority", "result", "scheduledFor", "scheduledJobId", "startedAt", "status", "type", "updatedAt") SELECT "attempts", "completedAt", "createdAt", "createdById", "errorMessage", "id", "maxAttempts", "payload", "priority", "result", "scheduledFor", "scheduledJobId", "startedAt", "status", "type", "updatedAt" FROM "tasks";
DROP TABLE "tasks";
ALTER TABLE "new_tasks" RENAME TO "tasks";
CREATE INDEX "tasks_status_priority_createdAt_idx" ON "tasks"("status", "priority", "createdAt");
CREATE INDEX "tasks_scheduledJobId_idx" ON "tasks"("scheduledJobId");
CREATE INDEX "tasks_type_status_idx" ON "tasks"("type", "status");
CREATE INDEX "tasks_projectId_status_idx" ON "tasks"("projectId", "status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
