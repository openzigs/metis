-- Issue #1431 — a ChatOps identity binding belongs to one workspace. Postgres
-- twin of the SQLite migration; see that file
-- (server/prisma/migrations/20261026001431_issue1431_chatops_identity_workspace_key)
-- for the full rationale.
--
-- The Teams and Slack identity bindings were unique on the external identity
-- alone, so one workspace's link overwrote another's. The key now leads with
-- workspaceId. Every existing row satisfies it, so no data moves.
--
-- Structural DDL is idempotent (#556), so the full history applies from empty.
--
-- Rollback (documentation) — fails if two workspaces now bind the same identity:
--   DROP INDEX "teams_user_identities_workspaceId_tenantId_aadObjectId_key";
--   CREATE UNIQUE INDEX "teams_user_identities_tenantId_aadObjectId_key" ON "teams_user_identities"("tenantId", "aadObjectId");
--   DROP INDEX "slack_user_identities_workspaceId_slackTeamId_slackUserId_key";
--   CREATE UNIQUE INDEX "slack_user_identities_slackTeamId_slackUserId_key" ON "slack_user_identities"("slackTeamId", "slackUserId");

-- DropIndex
DROP INDEX IF EXISTS "teams_user_identities_tenantId_aadObjectId_key";

-- DropIndex
DROP INDEX IF EXISTS "slack_user_identities_slackTeamId_slackUserId_key";

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "teams_user_identities_workspaceId_tenantId_aadObjectId_key" ON "teams_user_identities"("workspaceId", "tenantId", "aadObjectId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "slack_user_identities_workspaceId_slackTeamId_slackUserId_key" ON "slack_user_identities"("workspaceId", "slackTeamId", "slackUserId");
