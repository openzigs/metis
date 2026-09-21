-- Epic #547 (Phase 0, #548) — Microsoft Teams app foundation.
-- Postgres mirror of the SQLite migration.
--
-- Adds the `teams_app_installations` + `teams_conversation_references` tables.
-- ADDITIVE — no existing table is altered. All structural DDL is idempotent
-- (`IF NOT EXISTS`; FKs wrapped in pg_constraint existence DO-blocks) so the full
-- migration history replays cleanly over the cumulative `00000000000000_init`
-- baseline on a fresh Postgres (issue #556 guard).
--
-- SECRET HANDLING: the bot's Microsoft App Password is NOT a column here. Only a
-- `${vault:label}` reference is persisted in `appPasswordRef`.

-- CreateTable
CREATE TABLE IF NOT EXISTS "teams_app_installations" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "appPasswordRef" TEXT NOT NULL,
    "tenantId" TEXT,
    "appType" TEXT NOT NULL DEFAULT 'MultiTenant',
    "status" TEXT NOT NULL DEFAULT 'active',
    "label" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "teams_app_installations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "teams_conversation_references" (
    "id" TEXT NOT NULL,
    "installationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "serviceUrl" TEXT NOT NULL,
    "tenantId" TEXT,
    "channelId" TEXT NOT NULL,
    "aadObjectId" TEXT,
    "userId" TEXT,
    "reference" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "teams_conversation_references_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "teams_app_installations_workspaceId_idx" ON "teams_app_installations"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "teams_app_installations_workspaceId_appId_key" ON "teams_app_installations"("workspaceId", "appId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "teams_conversation_references_installationId_idx" ON "teams_conversation_references"("installationId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "teams_conversation_references_workspaceId_idx" ON "teams_conversation_references"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "teams_conversation_references_workspaceId_conversationId_key" ON "teams_conversation_references"("workspaceId", "conversationId");

-- AddForeignKey (guarded — bare ADD CONSTRAINT has no IF NOT EXISTS in Postgres)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'teams_app_installations_workspaceId_fkey') THEN
    ALTER TABLE "teams_app_installations" ADD CONSTRAINT "teams_app_installations_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'teams_app_installations_createdById_fkey') THEN
    ALTER TABLE "teams_app_installations" ADD CONSTRAINT "teams_app_installations_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'teams_conversation_references_installationId_fkey') THEN
    ALTER TABLE "teams_conversation_references" ADD CONSTRAINT "teams_conversation_references_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "teams_app_installations" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
