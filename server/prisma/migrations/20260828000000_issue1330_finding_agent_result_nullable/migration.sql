-- Issue #1330 (ADR 0011) — make `findings.agentResultId` NULLABLE.
--
-- A Finding materialised from an approved ScanFinding has no analysis
-- AgentResult behind it: the AI bug scanner is not an analysis agent and never
-- creates one. `agentResultId` was NOT NULL with no default, so
-- `materializeTriagedFinding` could not write a row at all — approved triage has
-- 500'd since Epic #708, and because the failure lands inside the transaction
-- AFTER the triage stamp, the rollback destroyed the triage decision too.
--
-- The alternative (synthesising a per-scan AgentResult with
-- agentKey='ai_bug_scanner') was rejected: it fabricates an analysis agent run
-- that never happened and pollutes every query that reasons over AgentResult.
-- The provenance of a materialised row is `findings.scanFindingId`, a column
-- added by Epic #708 for exactly this purpose and never written until now.
--
-- Exactly one of (agentResultId, scanFindingId) is set on any row. SQLite has
-- no CHECK-constraint introspection in Prisma so that rule cannot live in the
-- schema; it is asserted in server/src/lib/scanner/prisma-adapter.test.ts and
-- server/tests/finding-provenance-ratchet.test.ts.
--
-- SQLite cannot relax a NOT NULL in place, so Prisma rebuilds the table. No
-- existing row changes value: every current `findings` row has a non-null
-- agentResultId and the INSERT..SELECT copies it verbatim.
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_findings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentResultId" TEXT,
    "category" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'info',
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "evidence" TEXT,
    "derivation" TEXT NOT NULL DEFAULT 'inferred',
    "confidence" REAL NOT NULL DEFAULT 0.7,
    "symbolId" TEXT,
    "scanFindingId" TEXT,
    "verificationStatus" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "findings_agentResultId_fkey" FOREIGN KEY ("agentResultId") REFERENCES "agent_results" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "findings_symbolId_fkey" FOREIGN KEY ("symbolId") REFERENCES "code_symbols" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "findings_scanFindingId_fkey" FOREIGN KEY ("scanFindingId") REFERENCES "scanner_scan_findings" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_findings" ("agentResultId", "body", "category", "confidence", "createdAt", "derivation", "evidence", "id", "scanFindingId", "severity", "symbolId", "title", "verificationStatus") SELECT "agentResultId", "body", "category", "confidence", "createdAt", "derivation", "evidence", "id", "scanFindingId", "severity", "symbolId", "title", "verificationStatus" FROM "findings";
DROP TABLE "findings";
ALTER TABLE "new_findings" RENAME TO "findings";
CREATE UNIQUE INDEX "findings_scanFindingId_key" ON "findings"("scanFindingId");
CREATE INDEX "findings_agentResultId_idx" ON "findings"("agentResultId");
CREATE INDEX "findings_category_severity_idx" ON "findings"("category", "severity");
CREATE INDEX "findings_derivation_idx" ON "findings"("derivation");
CREATE INDEX "findings_symbolId_idx" ON "findings"("symbolId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
