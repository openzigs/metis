-- Issue #67 — one-way Microsoft Teams notification targets.
-- Postgres mirror of the SQLite migration.
--
-- Adds the `teams_notification_targets` table. ADDITIVE — no existing table is
-- altered. All structural DDL is idempotent (`IF NOT EXISTS`; FKs wrapped in
-- pg_constraint existence DO-blocks) so the full migration history replays
-- cleanly over the cumulative `00000000000000_init` baseline on a fresh Postgres
-- (issue #556 guard).

-- CreateTable
CREATE TABLE IF NOT EXISTS "teams_notification_targets" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "tenantId" TEXT,
    "reference" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "teams_notification_targets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "teams_notification_targets_workspaceId_idx" ON "teams_notification_targets"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "teams_notification_targets_workspaceId_eventType_key" ON "teams_notification_targets"("workspaceId", "eventType");

-- AddForeignKey (guarded — bare ADD CONSTRAINT has no IF NOT EXISTS in Postgres)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'teams_notification_targets_workspaceId_fkey') THEN
    ALTER TABLE "teams_notification_targets" ADD CONSTRAINT "teams_notification_targets_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'teams_notification_targets_createdById_fkey') THEN
    ALTER TABLE "teams_notification_targets" ADD CONSTRAINT "teams_notification_targets_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
