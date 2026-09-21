-- Epic #708 — AI Bug Scanner for Connected Repositories (PostgreSQL).
--
-- Mirrors the SQLite migration. Uses TIMESTAMP(3) / BOOLEAN / TEXT to match
-- the existing schema-parity conventions (string + JSON-encoded-as-text).

-- CreateTable
CREATE TABLE IF NOT EXISTS "scanner_rule_sets" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scanner_rule_sets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "scanner_rule_sets_projectId_name_key" ON "scanner_rule_sets"("projectId", "name");
CREATE INDEX IF NOT EXISTS "scanner_rule_sets_projectId_isActive_idx" ON "scanner_rule_sets"("projectId", "isActive");

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scanner_rule_sets_projectId_fkey') THEN
    EXECUTE 'ALTER TABLE "scanner_rule_sets" ADD CONSTRAINT "scanner_rule_sets_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END
$idem$;
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scanner_rule_sets_createdById_fkey') THEN
    EXECUTE 'ALTER TABLE "scanner_rule_sets" ADD CONSTRAINT "scanner_rule_sets_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE';
  END IF;
END
$idem$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "scanner_rules" (
    "id" TEXT NOT NULL,
    "ruleSetId" TEXT NOT NULL,
    "naturalLanguage" TEXT NOT NULL,
    "compiledMeta" TEXT NOT NULL DEFAULT '',
    "exemplarGrades" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "severity" TEXT NOT NULL DEFAULT 'medium',
    "category" TEXT NOT NULL DEFAULT 'security',
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scanner_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "scanner_rules_ruleSetId_idx" ON "scanner_rules"("ruleSetId");
CREATE INDEX IF NOT EXISTS "scanner_rules_status_idx" ON "scanner_rules"("status");

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scanner_rules_ruleSetId_fkey') THEN
    EXECUTE 'ALTER TABLE "scanner_rules" ADD CONSTRAINT "scanner_rules_ruleSetId_fkey" FOREIGN KEY ("ruleSetId") REFERENCES "scanner_rule_sets"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END
$idem$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "scanner_scans" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "repoConnectionId" TEXT NOT NULL,
    "commitSha" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "mode" TEXT NOT NULL DEFAULT 'rules',
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "totalSymbols" INTEGER NOT NULL DEFAULT 0,
    "scannedSymbols" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "costCents" INTEGER NOT NULL DEFAULT 0,
    "budgetCapTokens" INTEGER NOT NULL DEFAULT 2000000,
    "errorMessage" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scanner_scans_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "scanner_scans_projectId_status_idx" ON "scanner_scans"("projectId", "status");
CREATE INDEX IF NOT EXISTS "scanner_scans_repoConnectionId_createdAt_idx" ON "scanner_scans"("repoConnectionId", "createdAt");

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scanner_scans_projectId_fkey') THEN
    EXECUTE 'ALTER TABLE "scanner_scans" ADD CONSTRAINT "scanner_scans_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END
$idem$;
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scanner_scans_repoConnectionId_fkey') THEN
    EXECUTE 'ALTER TABLE "scanner_scans" ADD CONSTRAINT "scanner_scans_repoConnectionId_fkey" FOREIGN KEY ("repoConnectionId") REFERENCES "repo_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END
$idem$;
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scanner_scans_createdById_fkey') THEN
    EXECUTE 'ALTER TABLE "scanner_scans" ADD CONSTRAINT "scanner_scans_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE';
  END IF;
END
$idem$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "scanner_scan_findings" (
    "id" TEXT NOT NULL,
    "scanId" TEXT NOT NULL,
    "ruleId" TEXT,
    "symbolId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'medium',
    "category" TEXT NOT NULL DEFAULT 'security',
    "evidenceLines" TEXT NOT NULL DEFAULT '[]',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "triageStatus" TEXT NOT NULL DEFAULT 'pending',
    "triageNote" TEXT,
    "triagedAt" TIMESTAMP(3),
    "triagedById" TEXT,
    "materializedFindingId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scanner_scan_findings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "scanner_scan_findings_scanId_fingerprint_key" ON "scanner_scan_findings"("scanId", "fingerprint");
CREATE UNIQUE INDEX IF NOT EXISTS "scanner_scan_findings_materializedFindingId_key" ON "scanner_scan_findings"("materializedFindingId");
CREATE INDEX IF NOT EXISTS "scanner_scan_findings_scanId_triageStatus_idx" ON "scanner_scan_findings"("scanId", "triageStatus");
CREATE INDEX IF NOT EXISTS "scanner_scan_findings_symbolId_idx" ON "scanner_scan_findings"("symbolId");
CREATE INDEX IF NOT EXISTS "scanner_scan_findings_fingerprint_idx" ON "scanner_scan_findings"("fingerprint");

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scanner_scan_findings_scanId_fkey') THEN
    EXECUTE 'ALTER TABLE "scanner_scan_findings" ADD CONSTRAINT "scanner_scan_findings_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "scanner_scans"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END
$idem$;
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scanner_scan_findings_ruleId_fkey') THEN
    EXECUTE 'ALTER TABLE "scanner_scan_findings" ADD CONSTRAINT "scanner_scan_findings_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "scanner_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE';
  END IF;
END
$idem$;
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scanner_scan_findings_symbolId_fkey') THEN
    EXECUTE 'ALTER TABLE "scanner_scan_findings" ADD CONSTRAINT "scanner_scan_findings_symbolId_fkey" FOREIGN KEY ("symbolId") REFERENCES "code_symbols"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END
$idem$;
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scanner_scan_findings_triagedById_fkey') THEN
    EXECUTE 'ALTER TABLE "scanner_scan_findings" ADD CONSTRAINT "scanner_scan_findings_triagedById_fkey" FOREIGN KEY ("triagedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE';
  END IF;
END
$idem$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "scanner_issue_links" (
    "id" TEXT NOT NULL,
    "scanFindingId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "externalUrl" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scanner_issue_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "scanner_issue_links_scanFindingId_provider_key" ON "scanner_issue_links"("scanFindingId", "provider");
CREATE INDEX IF NOT EXISTS "scanner_issue_links_provider_externalId_idx" ON "scanner_issue_links"("provider", "externalId");
CREATE INDEX IF NOT EXISTS "scanner_issue_links_fingerprint_idx" ON "scanner_issue_links"("fingerprint");

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scanner_issue_links_scanFindingId_fkey') THEN
    EXECUTE 'ALTER TABLE "scanner_issue_links" ADD CONSTRAINT "scanner_issue_links_scanFindingId_fkey" FOREIGN KEY ("scanFindingId") REFERENCES "scanner_scan_findings"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END
$idem$;

-- AlterTable findings — add scanFindingId back-link.
ALTER TABLE "findings" ADD COLUMN IF NOT EXISTS "scanFindingId" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "findings_scanFindingId_key" ON "findings"("scanFindingId");
