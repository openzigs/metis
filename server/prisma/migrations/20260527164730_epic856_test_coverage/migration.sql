-- CreateTable
CREATE TABLE "test_coverage_runs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "mode" TEXT NOT NULL DEFAULT 'A',
    "contentHash" TEXT NOT NULL,
    "tokenCostCents" INTEGER NOT NULL DEFAULT 0,
    "phaseProgress" TEXT NOT NULL DEFAULT '{}',
    "error" TEXT,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "test_coverage_runs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "test_case_imports" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "runId" TEXT,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "label" TEXT NOT NULL DEFAULT '',
    "testCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "test_case_imports_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "test_case_imports_runId_fkey" FOREIGN KEY ("runId") REFERENCES "test_coverage_runs" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "test_case_docs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "sourceImportId" TEXT NOT NULL,
    "externalId" TEXT,
    "title" TEXT NOT NULL,
    "preconditions" TEXT,
    "stepsJson" TEXT NOT NULL DEFAULT '[]',
    "expected" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'medium',
    "tags" TEXT NOT NULL DEFAULT '[]',
    "source" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "test_case_docs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "test_case_docs_sourceImportId_fkey" FOREIGN KEY ("sourceImportId") REFERENCES "test_case_imports" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "coverage_mappings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "testCaseDocId" TEXT NOT NULL,
    "cosine" REAL NOT NULL,
    "bm25" REAL NOT NULL DEFAULT 0,
    "fused" REAL NOT NULL,
    "judgeConfidence" REAL,
    "status" TEXT NOT NULL,
    "overriddenById" TEXT,
    "overrideReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "coverage_mappings_runId_fkey" FOREIGN KEY ("runId") REFERENCES "test_coverage_runs" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "coverage_mappings_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "requirements" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "coverage_mappings_testCaseDocId_fkey" FOREIGN KEY ("testCaseDocId") REFERENCES "test_case_docs" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "test_coverage_gaps" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'medium',
    "meta" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "test_coverage_gaps_runId_fkey" FOREIGN KEY ("runId") REFERENCES "test_coverage_runs" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "test_coverage_gaps_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "requirements" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "test_coverage_suggestions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "mappedRequirementIds" TEXT NOT NULL DEFAULT '[]',
    "title" TEXT NOT NULL,
    "gwtJson" TEXT NOT NULL DEFAULT '{}',
    "stepsJson" TEXT NOT NULL DEFAULT '[]',
    "faithfulness" REAL NOT NULL DEFAULT 0,
    "sourceChunks" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "lowConfidence" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "test_coverage_suggestions_runId_fkey" FOREIGN KEY ("runId") REFERENCES "test_coverage_runs" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "test_coverage_runs_projectId_status_idx" ON "test_coverage_runs"("projectId", "status");

-- CreateIndex
CREATE INDEX "test_coverage_runs_contentHash_idx" ON "test_coverage_runs"("contentHash");

-- CreateIndex
CREATE INDEX "test_case_imports_projectId_status_idx" ON "test_case_imports"("projectId", "status");

-- CreateIndex
CREATE INDEX "test_case_imports_runId_idx" ON "test_case_imports"("runId");

-- CreateIndex
CREATE INDEX "test_case_docs_projectId_contentHash_idx" ON "test_case_docs"("projectId", "contentHash");

-- CreateIndex
CREATE UNIQUE INDEX "test_case_docs_projectId_source_externalId_key" ON "test_case_docs"("projectId", "source", "externalId");

-- CreateIndex
CREATE INDEX "coverage_mappings_runId_status_idx" ON "coverage_mappings"("runId", "status");

-- CreateIndex
CREATE INDEX "coverage_mappings_requirementId_idx" ON "coverage_mappings"("requirementId");

-- CreateIndex
CREATE UNIQUE INDEX "coverage_mappings_runId_requirementId_testCaseDocId_key" ON "coverage_mappings"("runId", "requirementId", "testCaseDocId");

-- CreateIndex
CREATE INDEX "test_coverage_gaps_runId_severity_idx" ON "test_coverage_gaps"("runId", "severity");

-- CreateIndex
CREATE UNIQUE INDEX "test_coverage_gaps_runId_requirementId_key" ON "test_coverage_gaps"("runId", "requirementId");

-- CreateIndex
CREATE INDEX "test_coverage_suggestions_runId_status_idx" ON "test_coverage_suggestions"("runId", "status");
