-- Issue #1431 — a ChatOps identity binding belongs to one workspace.
--
-- `teams_user_identities` was unique on (tenantId, aadObjectId) and
-- `slack_user_identities` on (slackTeamId, slackUserId), with no workspace. The
-- link route upserted on that key, so workspace B's admin re-linking a person
-- already linked by workspace A rewrote A's row (its workspaceId and userId).
-- The key now leads with workspaceId: each workspace holds its own binding of a
-- person, a link or unlink can only ever touch the caller's workspace's row, and
-- the command-time resolver looks a sender up in the bot's own workspace.
--
-- Every existing row satisfies the new key (the old one was strictly narrower),
-- so no data moves. Rows written through the old, unscoped route are not
-- trusted: the resolver also requires the bound user to be an active member of
-- the workspace, so a pre-fix binding naming a non-member stops resolving.
--
-- Rollback (documentation) — fails if two workspaces now bind the same identity:
--   DROP INDEX "teams_user_identities_workspaceId_tenantId_aadObjectId_key";
--   CREATE UNIQUE INDEX "teams_user_identities_tenantId_aadObjectId_key" ON "teams_user_identities"("tenantId", "aadObjectId");
--   DROP INDEX "slack_user_identities_workspaceId_slackTeamId_slackUserId_key";
--   CREATE UNIQUE INDEX "slack_user_identities_slackTeamId_slackUserId_key" ON "slack_user_identities"("slackTeamId", "slackUserId");

-- DropIndex
DROP INDEX "teams_user_identities_tenantId_aadObjectId_key";

-- DropIndex
DROP INDEX "slack_user_identities_slackTeamId_slackUserId_key";

-- CreateIndex
CREATE UNIQUE INDEX "teams_user_identities_workspaceId_tenantId_aadObjectId_key" ON "teams_user_identities"("workspaceId", "tenantId", "aadObjectId");

-- CreateIndex
CREATE UNIQUE INDEX "slack_user_identities_workspaceId_slackTeamId_slackUserId_key" ON "slack_user_identities"("workspaceId", "slackTeamId", "slackUserId");
