-- CreateTable
CREATE TABLE "spec_kit_features" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "branchName" TEXT,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "spec_kit_features_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "spec_kit_feature_artifacts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "featureId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "spec_kit_feature_artifacts_featureId_fkey" FOREIGN KEY ("featureId") REFERENCES "spec_kit_features" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "spec_kit_constitutions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "version" TEXT NOT NULL DEFAULT '0.0.0',
    "ratifiedAt" DATETIME,
    "lastAmendedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "spec_kit_configs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "checklistDomains" TEXT NOT NULL DEFAULT '[]',
    "tasksToIssuesParentEpic" INTEGER,
    "tasksToIssuesRepo" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "spec_kit_task_exports" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "featureSlug" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "issueNumber" INTEGER NOT NULL,
    "repoOwner" TEXT NOT NULL,
    "repoName" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_findings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentResultId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'info',
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "evidence" TEXT,
    "derivation" TEXT NOT NULL DEFAULT 'inferred',
    "confidence" REAL NOT NULL DEFAULT 0.7,
    "symbolId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "findings_agentResultId_fkey" FOREIGN KEY ("agentResultId") REFERENCES "agent_results" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "findings_symbolId_fkey" FOREIGN KEY ("symbolId") REFERENCES "code_symbols" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_findings" ("agentResultId", "body", "category", "confidence", "createdAt", "derivation", "evidence", "id", "severity", "symbolId", "title") SELECT "agentResultId", "body", "category", "confidence", "createdAt", "derivation", "evidence", "id", "severity", "symbolId", "title" FROM "findings";
DROP TABLE "findings";
ALTER TABLE "new_findings" RENAME TO "findings";
CREATE INDEX "findings_agentResultId_idx" ON "findings"("agentResultId");
CREATE INDEX "findings_category_severity_idx" ON "findings"("category", "severity");
CREATE INDEX "findings_derivation_idx" ON "findings"("derivation");
CREATE INDEX "findings_symbolId_idx" ON "findings"("symbolId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "spec_kit_features_projectId_idx" ON "spec_kit_features"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "spec_kit_features_projectId_slug_key" ON "spec_kit_features"("projectId", "slug");

-- CreateIndex
CREATE INDEX "spec_kit_feature_artifacts_featureId_idx" ON "spec_kit_feature_artifacts"("featureId");

-- CreateIndex
CREATE UNIQUE INDEX "spec_kit_feature_artifacts_featureId_key_key" ON "spec_kit_feature_artifacts"("featureId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "spec_kit_constitutions_projectId_key" ON "spec_kit_constitutions"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "spec_kit_configs_projectId_key" ON "spec_kit_configs"("projectId");

-- CreateIndex
CREATE INDEX "spec_kit_task_exports_projectId_featureSlug_idx" ON "spec_kit_task_exports"("projectId", "featureSlug");

-- CreateIndex
CREATE UNIQUE INDEX "spec_kit_task_exports_projectId_featureSlug_taskId_key" ON "spec_kit_task_exports"("projectId", "featureSlug", "taskId");
