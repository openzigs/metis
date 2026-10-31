-- Issue #1621 — the portfolio assessment data model (epic #1608).
--
-- A requirement assessed across the product portfolio is persisted so it can
-- be traced later: `portfolio_assessments` (one run), with a row per product
-- (`portfolio_assessment_products`: coverage, impact kind, the edges the
-- impact went through, severity, BA and technical text) and per repo
-- (`portfolio_assessment_repos`: verdict and repo-aware citations).
--
-- The assessment is a SNAPSHOT. `statement` holds the text assessed and
-- `sourceRequirementId` is ON DELETE SET NULL, because requirements are
-- delete+recreated on every analysis re-run: a cascading key would delete the
-- assessment, a plain one would dangle. Product, repo, project and user ids are
-- scalar soft-links (no FK) for the same reason. JSON columns are TEXT.
--
-- Three new tables; no existing table or row is changed.
--
-- Rollback: server/prisma/rollbacks/20261107001621_issue1621_portfolio_assessment.sql
-- (exercised by server/tests/portfolio-assessment-migration-1621.sqlite.test.ts).
-- CreateTable
CREATE TABLE "portfolio_assessments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "statement" TEXT NOT NULL,
    "sourceRequirementId" TEXT,
    "sourceProjectId" TEXT,
    "scope" TEXT NOT NULL,
    "productIds" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "portfolioVerdict" TEXT,
    "summary" TEXT NOT NULL DEFAULT '',
    "costUsd" REAL NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "portfolio_assessments_sourceRequirementId_fkey" FOREIGN KEY ("sourceRequirementId") REFERENCES "requirements" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "portfolio_assessment_products" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "assessmentId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "coverage" TEXT NOT NULL,
    "impactKind" TEXT NOT NULL DEFAULT 'none',
    "via" TEXT,
    "edgeIds" TEXT NOT NULL DEFAULT '[]',
    "severity" TEXT,
    "baSummary" TEXT NOT NULL DEFAULT '',
    "technicalDetail" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "portfolio_assessment_products_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "portfolio_assessments" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "portfolio_assessment_repos" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "assessmentId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "repoConnectionId" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "citations" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "portfolio_assessment_repos_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "portfolio_assessments" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "portfolio_assessments_sourceRequirementId_idx" ON "portfolio_assessments"("sourceRequirementId");

-- CreateIndex
CREATE INDEX "portfolio_assessments_sourceProjectId_idx" ON "portfolio_assessments"("sourceProjectId");

-- CreateIndex
CREATE INDEX "portfolio_assessments_createdById_idx" ON "portfolio_assessments"("createdById");

-- CreateIndex
CREATE INDEX "portfolio_assessment_products_productId_idx" ON "portfolio_assessment_products"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "portfolio_assessment_products_assessmentId_productId_key" ON "portfolio_assessment_products"("assessmentId", "productId");

-- CreateIndex
CREATE INDEX "portfolio_assessment_repos_repoConnectionId_idx" ON "portfolio_assessment_repos"("repoConnectionId");

-- CreateIndex
CREATE UNIQUE INDEX "portfolio_assessment_repos_assessment_repo_key" ON "portfolio_assessment_repos"("assessmentId", "productId", "repoConnectionId");

