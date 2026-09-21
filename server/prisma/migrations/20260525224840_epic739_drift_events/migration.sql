-- CreateTable
CREATE TABLE "drift_events" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "publishedIssueId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "requirementId" TEXT,
    "source" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "fieldDiffs" TEXT NOT NULL,
    "externalSnapshot" TEXT NOT NULL,
    "localSnapshot" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "resolution" TEXT,
    "resolvedById" TEXT,
    "resolvedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "drift_events_publishedIssueId_fkey" FOREIGN KEY ("publishedIssueId") REFERENCES "published_issues" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "drift_events_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
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
    "scanFindingId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "findings_agentResultId_fkey" FOREIGN KEY ("agentResultId") REFERENCES "agent_results" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "findings_symbolId_fkey" FOREIGN KEY ("symbolId") REFERENCES "code_symbols" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "findings_scanFindingId_fkey" FOREIGN KEY ("scanFindingId") REFERENCES "scanner_scan_findings" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_findings" ("agentResultId", "body", "category", "confidence", "createdAt", "derivation", "evidence", "id", "scanFindingId", "severity", "symbolId", "title") SELECT "agentResultId", "body", "category", "confidence", "createdAt", "derivation", "evidence", "id", "scanFindingId", "severity", "symbolId", "title" FROM "findings";
DROP TABLE "findings";
ALTER TABLE "new_findings" RENAME TO "findings";
CREATE UNIQUE INDEX "findings_scanFindingId_key" ON "findings"("scanFindingId");
CREATE INDEX "findings_agentResultId_idx" ON "findings"("agentResultId");
CREATE INDEX "findings_category_severity_idx" ON "findings"("category", "severity");
CREATE INDEX "findings_derivation_idx" ON "findings"("derivation");
CREATE INDEX "findings_symbolId_idx" ON "findings"("symbolId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "drift_events_deliveryId_key" ON "drift_events"("deliveryId");

-- CreateIndex
CREATE INDEX "drift_events_projectId_status_idx" ON "drift_events"("projectId", "status");

-- CreateIndex
CREATE INDEX "drift_events_publishedIssueId_idx" ON "drift_events"("publishedIssueId");

-- CreateIndex
CREATE INDEX "drift_events_source_idx" ON "drift_events"("source");
