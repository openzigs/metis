-- Epic #708 — AI Bug Scanner for Connected Repositories (SQLite).
--
-- Adds RuleSet, Rule, Scan, ScanFinding, IssueLink tables plus a back-link
-- column on `findings` (`scanFindingId`) that links a triage-approved
-- ScanFinding into a materialised Finding row.

-- CreateTable
CREATE TABLE "scanner_rule_sets" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "scanner_rule_sets_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "scanner_rule_sets_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "scanner_rule_sets_projectId_name_key" ON "scanner_rule_sets"("projectId", "name");
CREATE INDEX "scanner_rule_sets_projectId_isActive_idx" ON "scanner_rule_sets"("projectId", "isActive");

-- CreateTable
CREATE TABLE "scanner_rules" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ruleSetId" TEXT NOT NULL,
    "naturalLanguage" TEXT NOT NULL,
    "compiledMeta" TEXT NOT NULL DEFAULT '',
    "exemplarGrades" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "severity" TEXT NOT NULL DEFAULT 'medium',
    "category" TEXT NOT NULL DEFAULT 'security',
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "scanner_rules_ruleSetId_fkey" FOREIGN KEY ("ruleSetId") REFERENCES "scanner_rule_sets" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "scanner_rules_ruleSetId_idx" ON "scanner_rules"("ruleSetId");
CREATE INDEX "scanner_rules_status_idx" ON "scanner_rules"("status");

-- CreateTable
CREATE TABLE "scanner_scans" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "repoConnectionId" TEXT NOT NULL,
    "commitSha" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "mode" TEXT NOT NULL DEFAULT 'rules',
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "totalSymbols" INTEGER NOT NULL DEFAULT 0,
    "scannedSymbols" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "costCents" INTEGER NOT NULL DEFAULT 0,
    "budgetCapTokens" INTEGER NOT NULL DEFAULT 2000000,
    "errorMessage" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "scanner_scans_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "scanner_scans_repoConnectionId_fkey" FOREIGN KEY ("repoConnectionId") REFERENCES "repo_connections" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "scanner_scans_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "scanner_scans_projectId_status_idx" ON "scanner_scans"("projectId", "status");
CREATE INDEX "scanner_scans_repoConnectionId_createdAt_idx" ON "scanner_scans"("repoConnectionId", "createdAt");

-- CreateTable
CREATE TABLE "scanner_scan_findings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scanId" TEXT NOT NULL,
    "ruleId" TEXT,
    "symbolId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'medium',
    "category" TEXT NOT NULL DEFAULT 'security',
    "evidenceLines" TEXT NOT NULL DEFAULT '[]',
    "confidence" REAL NOT NULL DEFAULT 0.5,
    "triageStatus" TEXT NOT NULL DEFAULT 'pending',
    "triageNote" TEXT,
    "triagedAt" DATETIME,
    "triagedById" TEXT,
    "materializedFindingId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "scanner_scan_findings_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "scanner_scans" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "scanner_scan_findings_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "scanner_rules" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "scanner_scan_findings_symbolId_fkey" FOREIGN KEY ("symbolId") REFERENCES "code_symbols" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "scanner_scan_findings_triagedById_fkey" FOREIGN KEY ("triagedById") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "scanner_scan_findings_scanId_fingerprint_key" ON "scanner_scan_findings"("scanId", "fingerprint");
CREATE UNIQUE INDEX "scanner_scan_findings_materializedFindingId_key" ON "scanner_scan_findings"("materializedFindingId");
CREATE INDEX "scanner_scan_findings_scanId_triageStatus_idx" ON "scanner_scan_findings"("scanId", "triageStatus");
CREATE INDEX "scanner_scan_findings_symbolId_idx" ON "scanner_scan_findings"("symbolId");
CREATE INDEX "scanner_scan_findings_fingerprint_idx" ON "scanner_scan_findings"("fingerprint");

-- CreateTable
CREATE TABLE "scanner_issue_links" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scanFindingId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "externalUrl" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "scanner_issue_links_scanFindingId_fkey" FOREIGN KEY ("scanFindingId") REFERENCES "scanner_scan_findings" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "scanner_issue_links_scanFindingId_provider_key" ON "scanner_issue_links"("scanFindingId", "provider");
CREATE INDEX "scanner_issue_links_provider_externalId_idx" ON "scanner_issue_links"("provider", "externalId");
CREATE INDEX "scanner_issue_links_fingerprint_idx" ON "scanner_issue_links"("fingerprint");

-- AlterTable findings — add scanFindingId back-link (nullable).
ALTER TABLE "findings" ADD COLUMN "scanFindingId" TEXT;

-- CreateIndex on findings.scanFindingId — Prisma marks the field @unique.
CREATE UNIQUE INDEX "findings_scanFindingId_key" ON "findings"("scanFindingId");
