-- Issue #67 — one-way Microsoft Teams notification targets.
--
-- Adds the `teams_notification_targets` table: a per-workspace mapping of
-- event-type → destination Teams channel `ConversationReference`, used to
-- proactively post a one-way notification card (analysis-complete,
-- publish-rolled-back, budget-exceeded) into a configured channel. Distinct from
-- `teams_channel_links` (#549), which is keyed to a DiscussionThread for
-- bidirectional message mirroring — a notification target carries no thread.
--
-- The migration is ADDITIVE — no existing table is altered — so it is
-- non-destructive and trivially reversible (DROP TABLE teams_notification_targets).
--
-- SECRET HANDLING: the bot's Microsoft App Password is NOT a column here. The
-- proactive send resolves it from the #548 vault at send time via the workspace's
-- TeamsAppInstallation; only the (non-secret) ConversationReference JSON is stored.

-- CreateTable
CREATE TABLE "teams_notification_targets" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "tenantId" TEXT,
    "reference" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "teams_notification_targets_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "teams_notification_targets_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "teams_notification_targets_workspaceId_idx" ON "teams_notification_targets"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "teams_notification_targets_workspaceId_eventType_key" ON "teams_notification_targets"("workspaceId", "eventType");
