-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_scanner_issue_links" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scanFindingId" TEXT,
    "findingId" TEXT,
    "provider" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "externalUrl" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "scanner_issue_links_scanFindingId_fkey" FOREIGN KEY ("scanFindingId") REFERENCES "scanner_scan_findings" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "scanner_issue_links_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "findings" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_scanner_issue_links" ("createdAt", "externalId", "externalUrl", "fingerprint", "id", "provider", "scanFindingId") SELECT "createdAt", "externalId", "externalUrl", "fingerprint", "id", "provider", "scanFindingId" FROM "scanner_issue_links";
DROP TABLE "scanner_issue_links";
ALTER TABLE "new_scanner_issue_links" RENAME TO "scanner_issue_links";
CREATE INDEX "scanner_issue_links_provider_externalId_idx" ON "scanner_issue_links"("provider", "externalId");
CREATE INDEX "scanner_issue_links_fingerprint_idx" ON "scanner_issue_links"("fingerprint");
CREATE INDEX "scanner_issue_links_findingId_idx" ON "scanner_issue_links"("findingId");
CREATE UNIQUE INDEX "scanner_issue_links_scanFindingId_provider_key" ON "scanner_issue_links"("scanFindingId", "provider");
CREATE UNIQUE INDEX "scanner_issue_links_findingId_provider_key" ON "scanner_issue_links"("findingId", "provider");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
