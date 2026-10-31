-- Issue #1621 — the portfolio assessment data model. Postgres twin of the
-- SQLite migration; see that file
-- (server/prisma/migrations/20261107001621_issue1621_portfolio_assessment) for
-- the full rationale. Three new tables, JSON as TEXT; `sourceRequirementId`
-- is ON DELETE SET NULL so an assessment outlives the requirement re-run.
--
-- Structural DDL is idempotent (#556), so the full history applies from empty.
--
-- Rollback: server/prisma/postgres/rollbacks/20261107001621_issue1621_portfolio_assessment.sql
-- CreateTable
CREATE TABLE IF NOT EXISTS "portfolio_assessments" (
    "id" TEXT NOT NULL,
    "statement" TEXT NOT NULL,
    "sourceRequirementId" TEXT,
    "sourceProjectId" TEXT,
    "scope" TEXT NOT NULL,
    "productIds" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "portfolioVerdict" TEXT,
    "summary" TEXT NOT NULL DEFAULT '',
    "costUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "portfolio_assessments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "portfolio_assessment_products" (
    "id" TEXT NOT NULL,
    "assessmentId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "coverage" TEXT NOT NULL,
    "impactKind" TEXT NOT NULL DEFAULT 'none',
    "via" TEXT,
    "edgeIds" TEXT NOT NULL DEFAULT '[]',
    "severity" TEXT,
    "baSummary" TEXT NOT NULL DEFAULT '',
    "technicalDetail" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "portfolio_assessment_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "portfolio_assessment_repos" (
    "id" TEXT NOT NULL,
    "assessmentId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "repoConnectionId" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "citations" TEXT NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "portfolio_assessment_repos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "portfolio_assessments_sourceRequirementId_idx" ON "portfolio_assessments"("sourceRequirementId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "portfolio_assessments_sourceProjectId_idx" ON "portfolio_assessments"("sourceProjectId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "portfolio_assessments_createdById_idx" ON "portfolio_assessments"("createdById");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "portfolio_assessment_products_productId_idx" ON "portfolio_assessment_products"("productId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "portfolio_assessment_products_assessmentId_productId_key" ON "portfolio_assessment_products"("assessmentId", "productId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "portfolio_assessment_repos_repoConnectionId_idx" ON "portfolio_assessment_repos"("repoConnectionId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "portfolio_assessment_repos_assessment_repo_key" ON "portfolio_assessment_repos"("assessmentId", "productId", "repoConnectionId");

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'portfolio_assessments_sourceRequirementId_fkey') THEN
    EXECUTE 'ALTER TABLE "portfolio_assessments" ADD CONSTRAINT "portfolio_assessments_sourceRequirementId_fkey" FOREIGN KEY ("sourceRequirementId") REFERENCES "requirements"("id") ON DELETE SET NULL ON UPDATE CASCADE';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'portfolio_assessment_products_assessmentId_fkey') THEN
    EXECUTE 'ALTER TABLE "portfolio_assessment_products" ADD CONSTRAINT "portfolio_assessment_products_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "portfolio_assessments"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'portfolio_assessment_repos_assessmentId_fkey') THEN
    EXECUTE 'ALTER TABLE "portfolio_assessment_repos" ADD CONSTRAINT "portfolio_assessment_repos_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "portfolio_assessments"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END
$idem$;
