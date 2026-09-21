-- Issue #579 (epic #63) — Slack app (Bolt SDK) install + identity binding.
--
-- Adds two tables:
--   - `slack_app_installations`: a per-(workspace, Slack team) registration whose
--     bot token is stored ONLY as a `${vault:label}` reference (the plaintext
--     `xoxb-...` token is AES-256-GCM-encrypted in the hardened vault, mirroring
--     #548 appPasswordRef / #580 routingKeyRef).
--   - `slack_user_identities`: a durable `(slackTeamId, slackUserId)→User` binding
--     established through the SSO email match (mirrors #549 TeamsUserIdentity).
--
-- ADDITIVE — no existing table is altered — so it is non-destructive and trivially
-- reversible (DROP TABLE slack_user_identities; DROP TABLE slack_app_installations).

-- CreateTable
CREATE TABLE "slack_app_installations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "slackTeamId" TEXT NOT NULL,
    "slackTeamName" TEXT,
    "botUserId" TEXT,
    "botTokenRef" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "label" TEXT,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "slack_app_installations_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "slack_app_installations_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "slack_user_identities" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "slackTeamId" TEXT NOT NULL,
    "slackUserId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "email" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "slack_user_identities_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "slack_user_identities_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "slack_app_installations_workspaceId_idx" ON "slack_app_installations"("workspaceId");

-- CreateIndex
CREATE INDEX "slack_app_installations_slackTeamId_idx" ON "slack_app_installations"("slackTeamId");

-- CreateIndex
CREATE UNIQUE INDEX "slack_app_installations_workspaceId_slackTeamId_key" ON "slack_app_installations"("workspaceId", "slackTeamId");

-- CreateIndex
CREATE INDEX "slack_user_identities_workspaceId_idx" ON "slack_user_identities"("workspaceId");

-- CreateIndex
CREATE INDEX "slack_user_identities_userId_idx" ON "slack_user_identities"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "slack_user_identities_slackTeamId_slackUserId_key" ON "slack_user_identities"("slackTeamId", "slackUserId");
