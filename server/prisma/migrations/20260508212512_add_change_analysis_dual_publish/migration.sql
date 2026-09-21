-- CreateTable
CREATE TABLE "change_analyses" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "baseAnalysisId" TEXT NOT NULL,
    "headAnalysisId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "summary" TEXT,
    "totalChanges" INTEGER NOT NULL DEFAULT 0,
    "additions" INTEGER NOT NULL DEFAULT 0,
    "removals" INTEGER NOT NULL DEFAULT 0,
    "modifications" INTEGER NOT NULL DEFAULT 0,
    "startedById" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "change_analyses_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "change_analyses_baseAnalysisId_fkey" FOREIGN KEY ("baseAnalysisId") REFERENCES "analyses" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "change_analyses_headAnalysisId_fkey" FOREIGN KEY ("headAnalysisId") REFERENCES "analyses" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "change_analyses_startedById_fkey" FOREIGN KEY ("startedById") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "requirement_changes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "changeAnalysisId" TEXT NOT NULL,
    "changeType" TEXT NOT NULL DEFAULT 'modified',
    "severity" TEXT NOT NULL DEFAULT 'medium',
    "impactScore" REAL NOT NULL DEFAULT 0.5,
    "requirementId" TEXT,
    "previousRequirementId" TEXT,
    "title" TEXT NOT NULL,
    "previousTitle" TEXT,
    "body" TEXT NOT NULL,
    "previousBody" TEXT,
    "diffSummary" TEXT,
    "reviewStatus" TEXT NOT NULL DEFAULT 'pending',
    "reviewedById" TEXT,
    "reviewedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "requirement_changes_changeAnalysisId_fkey" FOREIGN KEY ("changeAnalysisId") REFERENCES "change_analyses" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "requirement_changes_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "requirements" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "requirement_changes_previousRequirementId_fkey" FOREIGN KEY ("previousRequirementId") REFERENCES "requirements" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_published_issues" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "batchId" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "issueNumber" INTEGER NOT NULL,
    "issueId" TEXT NOT NULL,
    "htmlUrl" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'created',
    "destination" TEXT NOT NULL DEFAULT 'github',
    "parentIssueNumber" INTEGER,
    "dedupHash" TEXT,
    "bodyHash" TEXT,
    "errorMessage" TEXT,
    "publishedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "published_issues_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "publish_batches" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "published_issues_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "issue_drafts" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_published_issues" ("batchId", "bodyHash", "dedupHash", "draftId", "errorMessage", "htmlUrl", "id", "issueId", "issueNumber", "parentIssueNumber", "publishedAt", "status") SELECT "batchId", "bodyHash", "dedupHash", "draftId", "errorMessage", "htmlUrl", "id", "issueId", "issueNumber", "parentIssueNumber", "publishedAt", "status" FROM "published_issues";
DROP TABLE "published_issues";
ALTER TABLE "new_published_issues" RENAME TO "published_issues";
CREATE INDEX "published_issues_issueId_idx" ON "published_issues"("issueId");
CREATE INDEX "published_issues_dedupHash_idx" ON "published_issues"("dedupHash");
CREATE UNIQUE INDEX "published_issues_batchId_draftId_key" ON "published_issues"("batchId", "draftId");
CREATE UNIQUE INDEX "published_issues_batchId_issueNumber_key" ON "published_issues"("batchId", "issueNumber");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "change_analyses_projectId_idx" ON "change_analyses"("projectId");

-- CreateIndex
CREATE INDEX "change_analyses_baseAnalysisId_idx" ON "change_analyses"("baseAnalysisId");

-- CreateIndex
CREATE INDEX "change_analyses_headAnalysisId_idx" ON "change_analyses"("headAnalysisId");

-- CreateIndex
CREATE INDEX "requirement_changes_changeAnalysisId_idx" ON "requirement_changes"("changeAnalysisId");

-- CreateIndex
CREATE INDEX "requirement_changes_requirementId_idx" ON "requirement_changes"("requirementId");

-- CreateIndex
CREATE INDEX "requirement_changes_previousRequirementId_idx" ON "requirement_changes"("previousRequirementId");

-- CreateIndex
CREATE INDEX "requirement_changes_reviewStatus_idx" ON "requirement_changes"("reviewStatus");
