-- Issue #1051 — store the proposed columns the #791 gate kept out of an impact
-- result, so a reviewer can see what was ruled out and why. Until now a dropped
-- proposal lived only on the in-memory result and in a server log line, and was
-- gone as soon as the run was stored.
--
-- A table of its own, not more rows in "impact_affected_tables": nothing that
-- reads the affected tables can then take a ruled-out column for a change the
-- requirement needs. `disposition` is `rejected` (an existing write path already
-- takes the value as a parameter) or `optional` (settings persistence). The
-- four `writer*` columns locate the covering write path and are NULL for an
-- optional preference no writer relates to. New, empty table: no backfill, and
-- runs stored before this migration simply have no rows.
--
-- Rollback (documentation): DROP TABLE "impact_column_proposals";
-- Lossy only for the ruled-out proposals of runs stored after this migration.

-- CreateTable
CREATE TABLE "impact_column_proposals" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "impactItemId" TEXT NOT NULL,
    "disposition" TEXT NOT NULL,
    "tableName" TEXT NOT NULL,
    "columnName" TEXT NOT NULL,
    "columnType" TEXT,
    "suggestedDdl" TEXT,
    "reason" TEXT NOT NULL,
    "writerQualifiedName" TEXT,
    "writerFilePath" TEXT,
    "writerStartLine" INTEGER,
    "writerEndLine" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "impact_column_proposals_impactItemId_fkey" FOREIGN KEY ("impactItemId") REFERENCES "impact_items" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "impact_column_proposals_impactItemId_idx" ON "impact_column_proposals"("impactItemId");
