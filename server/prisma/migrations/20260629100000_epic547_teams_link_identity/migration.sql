-- Epic #547 (Phase 1, #549) — Teams thread↔channel link + AAD→METIS identity.
--
-- Adds the `teams_channel_links` + `teams_user_identities` tables:
--   - teams_channel_links maps a DiscussionThread ↔ a Teams channel within a
--     workspace (cardinality: ONE channel ↔ ONE thread per workspace, enforced by
--     two unique keys). Later phases (#550 outbound / #551 inbound) read it to
--     know which thread a channel mirrors.
--   - teams_user_identities binds a Teams sender's (tenantId, aadObjectId) to a
--     METIS user. Tenant-scoped unique key is the cross-tenant isolation boundary
--     (a foreign-tenant aadObjectId can never resolve to a local user).
--
-- The migration is ADDITIVE — no existing table is altered — so it is
-- non-destructive and trivially reversible
-- (DROP TABLE teams_user_identities; DROP TABLE teams_channel_links).

-- CreateTable
CREATE TABLE "teams_channel_links" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "tenantId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "teams_channel_links_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "teams_channel_links_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "discussion_threads" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "teams_channel_links_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "teams_user_identities" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "aadObjectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "email" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "teams_user_identities_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "teams_user_identities_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "teams_channel_links_workspaceId_idx" ON "teams_channel_links"("workspaceId");

-- CreateIndex
CREATE INDEX "teams_channel_links_projectId_idx" ON "teams_channel_links"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "teams_channel_links_workspaceId_conversationId_key" ON "teams_channel_links"("workspaceId", "conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "teams_channel_links_threadId_key" ON "teams_channel_links"("threadId");

-- CreateIndex
CREATE INDEX "teams_user_identities_workspaceId_idx" ON "teams_user_identities"("workspaceId");

-- CreateIndex
CREATE INDEX "teams_user_identities_userId_idx" ON "teams_user_identities"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "teams_user_identities_tenantId_aadObjectId_key" ON "teams_user_identities"("tenantId", "aadObjectId");
