-- Epic #776: Inbound importers (GitHub / Jira / Azure DevOps / Linear).
-- Adds external provenance + dedup columns to requirements and two new
-- tables (import_sources, import_runs) for saved imports and run history.

-- Requirement provenance columns (nullable; NULLs are distinct in the unique
-- index so existing rows never collide).
ALTER TABLE "requirements" ADD COLUMN "externalSource" TEXT;
ALTER TABLE "requirements" ADD COLUMN "externalId" TEXT;
ALTER TABLE "requirements" ADD COLUMN "externalUrl" TEXT;
ALTER TABLE "requirements" ADD COLUMN "importSourceId" TEXT;

CREATE INDEX "requirements_importSourceId_idx" ON "requirements"("importSourceId");
CREATE UNIQUE INDEX "requirements_projectId_externalSource_externalId_key" ON "requirements"("projectId", "externalSource", "externalId");

-- Saved import configuration.
CREATE TABLE "import_sources" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "filter" TEXT NOT NULL DEFAULT '{}',
    "baseUrl" TEXT,
    "jiraConnectionId" TEXT,
    "secretId" TEXT,
    "syncEnabled" BOOLEAN NOT NULL DEFAULT false,
    "syncIntervalMinutes" INTEGER NOT NULL DEFAULT 15,
    "scheduledJobId" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "disabledReason" TEXT,
    "lastRunAt" DATETIME,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME
);

CREATE INDEX "import_sources_projectId_idx" ON "import_sources"("projectId");
CREATE INDEX "import_sources_analysisId_idx" ON "import_sources"("analysisId");

-- Per-run execution record.
CREATE TABLE "import_runs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "importSourceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL DEFAULT 'manual',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "taskId" TEXT,
    "createdCount" INTEGER NOT NULL DEFAULT 0,
    "updatedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "totalFetched" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "import_runs_importSourceId_fkey" FOREIGN KEY ("importSourceId") REFERENCES "import_sources" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "import_runs_importSourceId_idx" ON "import_runs"("importSourceId");
CREATE INDEX "import_runs_projectId_createdAt_idx" ON "import_runs"("projectId", "createdAt");
