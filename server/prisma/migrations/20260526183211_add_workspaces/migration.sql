-- CreateTable
CREATE TABLE "workspaces" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "logoUrl" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME
);

-- CreateTable
CREATE TABLE "workspace_members" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "joinedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "workspace_members_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "workspace_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "workspace_invites" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "token" TEXT NOT NULL,
    "invitedById" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "consumedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "workspace_invites_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "workspace_invites_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "workspace_usage_daily" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "date" DATETIME NOT NULL,
    "tokensUsed" INTEGER NOT NULL DEFAULT 0,
    "costCents" INTEGER NOT NULL DEFAULT 0,
    "sessions" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "workspace_usage_daily_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_projects" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "aiProviderId" TEXT,
    "aiModel" TEXT,
    "monthlyTokenBudget" INTEGER,
    "safetyMode" TEXT NOT NULL DEFAULT 'standard',
    "autopilotEnabled" BOOLEAN NOT NULL DEFAULT false,
    "autopilotCostCeilingCents" INTEGER,
    "autoApproveTrustedSources" BOOLEAN NOT NULL DEFAULT false,
    "chronicleEnabled" BOOLEAN NOT NULL DEFAULT false,
    "chronicleTtlDays" INTEGER NOT NULL DEFAULT 28,
    "allowCredentialScan" BOOLEAN NOT NULL DEFAULT false,
    "redTeamLastRunAt" DATETIME,
    "redTeamLastScore" REAL,
    "skillDirectories" TEXT NOT NULL DEFAULT '[]',
    "disabledSkills" TEXT NOT NULL DEFAULT '[]',
    "planModeRequired" BOOLEAN NOT NULL DEFAULT false,
    "specKitEnabled" BOOLEAN NOT NULL DEFAULT false,
    "autoReviewPrs" BOOLEAN NOT NULL DEFAULT false,
    "autoApproveSandbox" BOOLEAN NOT NULL DEFAULT false,
    "prReviewMaxDiffBytes" INTEGER,
    "prReviewSkipGlobs" TEXT,
    "prReviewMonthlyBudgetCents" INTEGER,
    "sandboxProvider" TEXT NOT NULL DEFAULT 'e2b',
    "sandboxTimeoutMs" INTEGER NOT NULL DEFAULT 60000,
    "sandboxEgressAllowlist" TEXT NOT NULL DEFAULT '[]',
    "createdById" TEXT NOT NULL,
    "workspaceId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    "publishDestination" TEXT NOT NULL DEFAULT 'github',
    "jiraProjectKey" TEXT,
    "jiraConnectionId" TEXT,
    "productId" TEXT,
    "contextCompactionThreshold" INTEGER,
    "githubProjectId" TEXT,
    "githubProjectFieldMappings" TEXT,
    "overviewMarkdown" TEXT,
    "overviewGeneratedAt" DATETIME,
    CONSTRAINT "projects_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "projects_jiraConnectionId_fkey" FOREIGN KEY ("jiraConnectionId") REFERENCES "jira_connections" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "projects_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "projects_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_projects" ("aiModel", "aiProviderId", "allowCredentialScan", "autoApproveSandbox", "autoApproveTrustedSources", "autoReviewPrs", "autopilotCostCeilingCents", "autopilotEnabled", "chronicleEnabled", "chronicleTtlDays", "contextCompactionThreshold", "createdAt", "createdById", "deletedAt", "description", "disabledSkills", "githubProjectFieldMappings", "githubProjectId", "id", "jiraConnectionId", "jiraProjectKey", "monthlyTokenBudget", "name", "overviewGeneratedAt", "overviewMarkdown", "planModeRequired", "prReviewMaxDiffBytes", "prReviewMonthlyBudgetCents", "prReviewSkipGlobs", "productId", "publishDestination", "redTeamLastRunAt", "redTeamLastScore", "safetyMode", "sandboxEgressAllowlist", "sandboxProvider", "sandboxTimeoutMs", "skillDirectories", "slug", "specKitEnabled", "status", "updatedAt") SELECT "aiModel", "aiProviderId", "allowCredentialScan", "autoApproveSandbox", "autoApproveTrustedSources", "autoReviewPrs", "autopilotCostCeilingCents", "autopilotEnabled", "chronicleEnabled", "chronicleTtlDays", "contextCompactionThreshold", "createdAt", "createdById", "deletedAt", "description", "disabledSkills", "githubProjectFieldMappings", "githubProjectId", "id", "jiraConnectionId", "jiraProjectKey", "monthlyTokenBudget", "name", "overviewGeneratedAt", "overviewMarkdown", "planModeRequired", "prReviewMaxDiffBytes", "prReviewMonthlyBudgetCents", "prReviewSkipGlobs", "productId", "publishDestination", "redTeamLastRunAt", "redTeamLastScore", "safetyMode", "sandboxEgressAllowlist", "sandboxProvider", "sandboxTimeoutMs", "skillDirectories", "slug", "specKitEnabled", "status", "updatedAt" FROM "projects";
DROP TABLE "projects";
ALTER TABLE "new_projects" RENAME TO "projects";
CREATE UNIQUE INDEX "projects_slug_key" ON "projects"("slug");
CREATE INDEX "projects_status_idx" ON "projects"("status");
CREATE INDEX "projects_createdById_idx" ON "projects"("createdById");
CREATE INDEX "projects_workspaceId_idx" ON "projects"("workspaceId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "workspaces_slug_key" ON "workspaces"("slug");

-- CreateIndex
CREATE INDEX "workspaces_slug_idx" ON "workspaces"("slug");

-- CreateIndex
CREATE INDEX "workspace_members_userId_idx" ON "workspace_members"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_members_workspaceId_userId_key" ON "workspace_members"("workspaceId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_invites_token_key" ON "workspace_invites"("token");

-- CreateIndex
CREATE INDEX "workspace_invites_workspaceId_idx" ON "workspace_invites"("workspaceId");

-- CreateIndex
CREATE INDEX "workspace_invites_email_idx" ON "workspace_invites"("email");

-- CreateIndex
CREATE INDEX "workspace_invites_token_idx" ON "workspace_invites"("token");

-- CreateIndex
CREATE INDEX "workspace_usage_daily_workspaceId_date_idx" ON "workspace_usage_daily"("workspaceId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_usage_daily_workspaceId_date_key" ON "workspace_usage_daily"("workspaceId", "date");
