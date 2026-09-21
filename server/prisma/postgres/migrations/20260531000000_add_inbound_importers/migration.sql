-- Epic #776: Inbound importers (GitHub / Jira / Azure DevOps / Linear).
-- Adds external provenance + dedup columns to requirements and two new
-- tables (import_sources, import_runs) for saved imports and run history.

-- Requirement provenance columns (nullable; NULLs are distinct in the unique
-- index so existing rows never collide).
ALTER TABLE "requirements" ADD COLUMN IF NOT EXISTS "externalSource" TEXT;
ALTER TABLE "requirements" ADD COLUMN IF NOT EXISTS "externalId" TEXT;
ALTER TABLE "requirements" ADD COLUMN IF NOT EXISTS "externalUrl" TEXT;
ALTER TABLE "requirements" ADD COLUMN IF NOT EXISTS "importSourceId" TEXT;

CREATE INDEX IF NOT EXISTS "requirements_importSourceId_idx" ON "requirements"("importSourceId");
CREATE UNIQUE INDEX IF NOT EXISTS "requirements_projectId_externalSource_externalId_key" ON "requirements"("projectId", "externalSource", "externalId");

-- Saved import configuration.
CREATE TABLE IF NOT EXISTS "import_sources" (
    "id" TEXT NOT NULL,
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
    "lastRunAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "import_sources_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "import_sources_projectId_idx" ON "import_sources"("projectId");
CREATE INDEX IF NOT EXISTS "import_sources_analysisId_idx" ON "import_sources"("analysisId");

-- Per-run execution record.
CREATE TABLE IF NOT EXISTS "import_runs" (
    "id" TEXT NOT NULL,
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
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "import_runs_importSourceId_idx" ON "import_runs"("importSourceId");
CREATE INDEX IF NOT EXISTS "import_runs_projectId_createdAt_idx" ON "import_runs"("projectId", "createdAt");

DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'import_runs_importSourceId_fkey') THEN
    EXECUTE 'ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_importSourceId_fkey" FOREIGN KEY ("importSourceId") REFERENCES "import_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END
$idem$;
