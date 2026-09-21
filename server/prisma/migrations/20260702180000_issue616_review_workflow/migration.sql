-- Issue #616 (epic #609) -- formal review & approval workflow + baselines.
--
-- Adds `review_requests` (review container + status state machine),
-- `review_request_items` (scope: a Requirement or a GeneratedDocument spec,
-- pinned to the exact version under review), `reviewer_assignments`
-- (per-reviewer decision with timestamp + note), and `baselines` /
-- `baseline_items` ((requirementId, version) pins over the RequirementVersion
-- history substrate, epic #770).
--
-- ADDITIVE -- no existing table is altered -- so it is non-destructive and
-- trivially reversible (DROP the five new tables).

-- CreateTable
CREATE TABLE "review_requests" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "policy" TEXT NOT NULL DEFAULT 'all',
    "quorum" INTEGER,
    "requestedById" TEXT NOT NULL,
    "dueAt" DATETIME,
    "decidedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "review_requests_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "review_requests_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "review_request_items" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "reviewRequestId" TEXT NOT NULL,
    "requirementId" TEXT,
    "generatedDocumentId" TEXT,
    "pinnedVersion" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "review_request_items_reviewRequestId_fkey" FOREIGN KEY ("reviewRequestId") REFERENCES "review_requests" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "review_request_items_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "requirements" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "review_request_items_generatedDocumentId_fkey" FOREIGN KEY ("generatedDocumentId") REFERENCES "generated_documents" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "reviewer_assignments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "reviewRequestId" TEXT NOT NULL,
    "reviewerId" TEXT NOT NULL,
    "decision" TEXT NOT NULL DEFAULT 'pending',
    "note" TEXT,
    "decidedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "reviewer_assignments_reviewRequestId_fkey" FOREIGN KEY ("reviewRequestId") REFERENCES "review_requests" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "reviewer_assignments_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "baselines" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "reviewRequestId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "baselines_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "baselines_reviewRequestId_fkey" FOREIGN KEY ("reviewRequestId") REFERENCES "review_requests" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "baselines_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "baseline_items" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "baselineId" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "baseline_items_baselineId_fkey" FOREIGN KEY ("baselineId") REFERENCES "baselines" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "baseline_items_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "requirements" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "review_requests_projectId_status_idx" ON "review_requests"("projectId", "status");

-- CreateIndex
CREATE INDEX "review_requests_requestedById_idx" ON "review_requests"("requestedById");

-- CreateIndex
CREATE INDEX "review_request_items_requirementId_idx" ON "review_request_items"("requirementId");

-- CreateIndex
CREATE INDEX "review_request_items_generatedDocumentId_idx" ON "review_request_items"("generatedDocumentId");

-- CreateIndex
CREATE UNIQUE INDEX "review_request_items_reviewRequestId_requirementId_key" ON "review_request_items"("reviewRequestId", "requirementId");

-- CreateIndex
CREATE UNIQUE INDEX "review_request_items_reviewRequestId_generatedDocumentId_key" ON "review_request_items"("reviewRequestId", "generatedDocumentId");

-- CreateIndex
CREATE INDEX "reviewer_assignments_reviewerId_decision_idx" ON "reviewer_assignments"("reviewerId", "decision");

-- CreateIndex
CREATE UNIQUE INDEX "reviewer_assignments_reviewRequestId_reviewerId_key" ON "reviewer_assignments"("reviewRequestId", "reviewerId");

-- CreateIndex
CREATE UNIQUE INDEX "baselines_reviewRequestId_key" ON "baselines"("reviewRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "baselines_projectId_name_key" ON "baselines"("projectId", "name");

-- CreateIndex
CREATE INDEX "baseline_items_requirementId_idx" ON "baseline_items"("requirementId");

-- CreateIndex
CREATE UNIQUE INDEX "baseline_items_baselineId_requirementId_key" ON "baseline_items"("baselineId", "requirementId");

