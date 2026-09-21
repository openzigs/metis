-- Issue #579 (epic #63) — Slack app (Bolt SDK) install + identity binding.
-- Postgres mirror of the SQLite migration.
--
-- Adds the `slack_app_installations` and `slack_user_identities` tables. ADDITIVE
-- — no existing table is altered. All structural DDL is idempotent
-- (`IF NOT EXISTS`; FKs wrapped in pg_constraint existence DO-blocks) so the full
-- migration history replays cleanly over the cumulative `00000000000000_init`
-- baseline on a fresh Postgres (#556 guard).
--
-- SECRET HANDLING: the Slack bot token is NOT a column. Only the
-- `${vault:label}` reference is stored in `botTokenRef`.

-- CreateTable
CREATE TABLE IF NOT EXISTS "slack_app_installations" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "slackTeamId" TEXT NOT NULL,
    "slackTeamName" TEXT,
    "botUserId" TEXT,
    "botTokenRef" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "label" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "slack_app_installations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "slack_user_identities" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "slackTeamId" TEXT NOT NULL,
    "slackUserId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "email" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "slack_user_identities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "slack_app_installations_workspaceId_idx" ON "slack_app_installations"("workspaceId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "slack_app_installations_slackTeamId_idx" ON "slack_app_installations"("slackTeamId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "slack_app_installations_workspaceId_slackTeamId_key" ON "slack_app_installations"("workspaceId", "slackTeamId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "slack_user_identities_workspaceId_idx" ON "slack_user_identities"("workspaceId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "slack_user_identities_userId_idx" ON "slack_user_identities"("userId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "slack_user_identities_slackTeamId_slackUserId_key" ON "slack_user_identities"("slackTeamId", "slackUserId");

-- AddForeignKey (guarded — bare ADD CONSTRAINT has no IF NOT EXISTS in Postgres)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'slack_app_installations_workspaceId_fkey') THEN
    ALTER TABLE "slack_app_installations" ADD CONSTRAINT "slack_app_installations_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'slack_app_installations_createdById_fkey') THEN
    ALTER TABLE "slack_app_installations" ADD CONSTRAINT "slack_app_installations_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'slack_user_identities_workspaceId_fkey') THEN
    ALTER TABLE "slack_user_identities" ADD CONSTRAINT "slack_user_identities_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'slack_user_identities_userId_fkey') THEN
    ALTER TABLE "slack_user_identities" ADD CONSTRAINT "slack_user_identities_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
