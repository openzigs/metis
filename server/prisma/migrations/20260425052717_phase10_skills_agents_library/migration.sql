-- CreateTable
CREATE TABLE "skill_versions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "skillId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "manifest" TEXT NOT NULL DEFAULT '{}',
    "instructions" TEXT NOT NULL DEFAULT '',
    "contentSha256" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "skill_versions_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "skills" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "skill_versions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "agent_versions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "manifest" TEXT NOT NULL DEFAULT '{}',
    "systemPrompt" TEXT NOT NULL DEFAULT '',
    "contentSha256" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "agent_versions_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "agent_versions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "project_skill_allowlists" (
    "projectId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "addedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("projectId", "skillId"),
    CONSTRAINT "project_skill_allowlists_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "project_skill_allowlists_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "skills" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "project_agent_allowlists" (
    "projectId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "addedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("projectId", "agentId"),
    CONSTRAINT "project_agent_allowlists_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "project_agent_allowlists_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_agents" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "displayName" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL DEFAULT '',
    "model" TEXT NOT NULL DEFAULT '',
    "systemPrompt" TEXT NOT NULL DEFAULT '',
    "tools" TEXT NOT NULL DEFAULT '[]',
    "tags" TEXT NOT NULL DEFAULT '[]',
    "handoffs" TEXT NOT NULL DEFAULT '[]',
    "manifest" TEXT NOT NULL DEFAULT '{}',
    "contentSha256" TEXT,
    "source" TEXT NOT NULL DEFAULT 'inline',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "version" TEXT NOT NULL DEFAULT '0.1.0',
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "archivedAt" DATETIME,
    "deletedAt" DATETIME,
    CONSTRAINT "agents_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_agents" ("createdAt", "deletedAt", "description", "enabled", "id", "key", "manifest", "model", "name", "updatedAt") SELECT "createdAt", "deletedAt", "description", "enabled", "id", "key", "manifest", "model", "name", "updatedAt" FROM "agents";
DROP TABLE "agents";
ALTER TABLE "new_agents" RENAME TO "agents";
CREATE UNIQUE INDEX "agents_key_key" ON "agents"("key");
CREATE INDEX "agents_enabled_deletedAt_idx" ON "agents"("enabled", "deletedAt");
CREATE TABLE "new_ai_sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "projectId" TEXT,
    "title" TEXT NOT NULL DEFAULT 'New Chat',
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "policy" TEXT NOT NULL DEFAULT '{"low":"auto","medium":"prompt-once","high":"always-prompt"}',
    "status" TEXT NOT NULL DEFAULT 'active',
    "providerSecretRef" TEXT,
    "copilotHome" TEXT,
    "agentId" TEXT,
    "agentSnapshot" TEXT,
    "loadedSkillIds" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "ai_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ai_sessions_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ai_sessions_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_ai_sessions" ("copilotHome", "createdAt", "deletedAt", "id", "model", "policy", "projectId", "provider", "providerSecretRef", "status", "title", "updatedAt", "userId") SELECT "copilotHome", "createdAt", "deletedAt", "id", "model", "policy", "projectId", "provider", "providerSecretRef", "status", "title", "updatedAt", "userId" FROM "ai_sessions";
DROP TABLE "ai_sessions";
ALTER TABLE "new_ai_sessions" RENAME TO "ai_sessions";
CREATE INDEX "ai_sessions_userId_idx" ON "ai_sessions"("userId");
CREATE INDEX "ai_sessions_projectId_idx" ON "ai_sessions"("projectId");
CREATE INDEX "ai_sessions_status_idx" ON "ai_sessions"("status");
CREATE INDEX "ai_sessions_agentId_idx" ON "ai_sessions"("agentId");
CREATE TABLE "new_issue_drafts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "requirementId" TEXT,
    "parentDraftId" TEXT,
    "draftType" TEXT NOT NULL DEFAULT 'feature',
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "labels" TEXT NOT NULL DEFAULT '[]',
    "assignees" TEXT NOT NULL DEFAULT '[]',
    "storyPoints" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "dedupHash" TEXT,
    "metadata" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "issue_drafts_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "issue_drafts_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "requirements" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "issue_drafts_parentDraftId_fkey" FOREIGN KEY ("parentDraftId") REFERENCES "issue_drafts" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_issue_drafts" ("assignees", "body", "createdAt", "dedupHash", "deletedAt", "draftType", "id", "labels", "metadata", "parentDraftId", "projectId", "requirementId", "status", "storyPoints", "title", "updatedAt") SELECT "assignees", "body", "createdAt", "dedupHash", "deletedAt", "draftType", "id", "labels", "metadata", "parentDraftId", "projectId", "requirementId", "status", "storyPoints", "title", "updatedAt" FROM "issue_drafts";
DROP TABLE "issue_drafts";
ALTER TABLE "new_issue_drafts" RENAME TO "issue_drafts";
CREATE INDEX "issue_drafts_projectId_status_idx" ON "issue_drafts"("projectId", "status");
CREATE INDEX "issue_drafts_requirementId_idx" ON "issue_drafts"("requirementId");
CREATE INDEX "issue_drafts_parentDraftId_idx" ON "issue_drafts"("parentDraftId");
CREATE INDEX "issue_drafts_dedupHash_idx" ON "issue_drafts"("dedupHash");
CREATE TABLE "new_skills" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "version" TEXT NOT NULL DEFAULT '0.1.0',
    "instructions" TEXT NOT NULL DEFAULT '',
    "tools" TEXT NOT NULL DEFAULT '[]',
    "resources" TEXT NOT NULL DEFAULT '[]',
    "tags" TEXT NOT NULL DEFAULT '[]',
    "manifest" TEXT NOT NULL DEFAULT '{}',
    "contentSha256" TEXT,
    "source" TEXT NOT NULL DEFAULT 'inline',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "archivedAt" DATETIME,
    "deletedAt" DATETIME,
    CONSTRAINT "skills_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_skills" ("createdAt", "deletedAt", "description", "enabled", "id", "key", "manifest", "name", "updatedAt", "version") SELECT "createdAt", "deletedAt", "description", "enabled", "id", "key", "manifest", "name", "updatedAt", "version" FROM "skills";
DROP TABLE "skills";
ALTER TABLE "new_skills" RENAME TO "skills";
CREATE UNIQUE INDEX "skills_key_key" ON "skills"("key");
CREATE INDEX "skills_enabled_deletedAt_idx" ON "skills"("enabled", "deletedAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "skill_versions_skillId_createdAt_idx" ON "skill_versions"("skillId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "skill_versions_skillId_version_key" ON "skill_versions"("skillId", "version");

-- CreateIndex
CREATE INDEX "agent_versions_agentId_createdAt_idx" ON "agent_versions"("agentId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "agent_versions_agentId_version_key" ON "agent_versions"("agentId", "version");

-- CreateIndex
CREATE INDEX "project_skill_allowlists_skillId_idx" ON "project_skill_allowlists"("skillId");

-- CreateIndex
CREATE INDEX "project_agent_allowlists_agentId_idx" ON "project_agent_allowlists"("agentId");
