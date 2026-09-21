-- CreateTable
CREATE TABLE "generated_documents" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'full',
    "scopeFilter" TEXT NOT NULL DEFAULT '{}',
    "content" TEXT NOT NULL DEFAULT '',
    "codeGraphHash" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "errorMessage" TEXT,
    "autoUpdate" BOOLEAN NOT NULL DEFAULT false,
    "generatedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "generated_documents_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "generated_document_versions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "documentId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "diffSummary" TEXT,
    "changedSymbols" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "generated_document_versions_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "generated_documents" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "docs_gen_fact_cache" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "cacheKey" TEXT NOT NULL,
    "modulePath" TEXT NOT NULL,
    "fileFingerprint" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersion" INTEGER NOT NULL DEFAULT 1,
    "facts" TEXT NOT NULL,
    "formulasJson" TEXT NOT NULL DEFAULT '[]',
    "minedRulesJson" TEXT NOT NULL DEFAULT '[]',
    "topClassesJson" TEXT NOT NULL DEFAULT '[]',
    "classCount" INTEGER NOT NULL DEFAULT 0,
    "methodCount" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "hitCount" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "docs_gen_fact_cache_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "jira_connections" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "edition" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "secretId" TEXT NOT NULL,
    "proxyUrl" TEXT,
    "tlsRejectUnauthorized" BOOLEAN NOT NULL DEFAULT true,
    "tlsCaSecretId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'untested',
    "errorMessage" TEXT,
    "lastTestedAt" DATETIME,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "jira_connections_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "jira_connections_secretId_fkey" FOREIGN KEY ("secretId") REFERENCES "secrets" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "jira_connections_tlsCaSecretId_fkey" FOREIGN KEY ("tlsCaSecretId") REFERENCES "secrets" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "jira_connections_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
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
    CONSTRAINT "projects_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_projects" ("aiModel", "aiProviderId", "autoApproveSandbox", "autoApproveTrustedSources", "autoReviewPrs", "autopilotCostCeilingCents", "autopilotEnabled", "chronicleEnabled", "chronicleTtlDays", "contextCompactionThreshold", "createdAt", "createdById", "deletedAt", "description", "disabledSkills", "githubProjectFieldMappings", "githubProjectId", "id", "monthlyTokenBudget", "name", "overviewGeneratedAt", "overviewMarkdown", "planModeRequired", "prReviewMaxDiffBytes", "prReviewMonthlyBudgetCents", "prReviewSkipGlobs", "productId", "redTeamLastRunAt", "redTeamLastScore", "safetyMode", "sandboxEgressAllowlist", "sandboxProvider", "sandboxTimeoutMs", "skillDirectories", "slug", "specKitEnabled", "status", "updatedAt") SELECT "aiModel", "aiProviderId", "autoApproveSandbox", "autoApproveTrustedSources", "autoReviewPrs", "autopilotCostCeilingCents", "autopilotEnabled", "chronicleEnabled", "chronicleTtlDays", "contextCompactionThreshold", "createdAt", "createdById", "deletedAt", "description", "disabledSkills", "githubProjectFieldMappings", "githubProjectId", "id", "monthlyTokenBudget", "name", "overviewGeneratedAt", "overviewMarkdown", "planModeRequired", "prReviewMaxDiffBytes", "prReviewMonthlyBudgetCents", "prReviewSkipGlobs", "productId", "redTeamLastRunAt", "redTeamLastScore", "safetyMode", "sandboxEgressAllowlist", "sandboxProvider", "sandboxTimeoutMs", "skillDirectories", "slug", "specKitEnabled", "status", "updatedAt" FROM "projects";
DROP TABLE "projects";
ALTER TABLE "new_projects" RENAME TO "projects";
CREATE UNIQUE INDEX "projects_slug_key" ON "projects"("slug");
CREATE INDEX "projects_status_idx" ON "projects"("status");
CREATE INDEX "projects_createdById_idx" ON "projects"("createdById");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "generated_documents_projectId_status_idx" ON "generated_documents"("projectId", "status");

-- CreateIndex
CREATE INDEX "generated_documents_projectId_scope_idx" ON "generated_documents"("projectId", "scope");

-- CreateIndex
CREATE INDEX "generated_document_versions_documentId_version_idx" ON "generated_document_versions"("documentId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "generated_document_versions_documentId_version_key" ON "generated_document_versions"("documentId", "version");

-- CreateIndex
CREATE INDEX "docs_gen_fact_cache_projectId_modulePath_idx" ON "docs_gen_fact_cache"("projectId", "modulePath");

-- CreateIndex
CREATE INDEX "docs_gen_fact_cache_lastUsedAt_idx" ON "docs_gen_fact_cache"("lastUsedAt");

-- CreateIndex
CREATE UNIQUE INDEX "docs_gen_fact_cache_projectId_cacheKey_key" ON "docs_gen_fact_cache"("projectId", "cacheKey");

-- CreateIndex
CREATE INDEX "jira_connections_projectId_idx" ON "jira_connections"("projectId");

-- CreateIndex
CREATE INDEX "jira_connections_createdById_idx" ON "jira_connections"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "jira_connections_projectId_label_key" ON "jira_connections"("projectId", "label");
