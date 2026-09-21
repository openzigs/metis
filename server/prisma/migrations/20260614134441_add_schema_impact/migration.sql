-- AlterTable
ALTER TABLE "code_edges" ADD COLUMN "source" TEXT;

-- AlterTable
ALTER TABLE "code_symbols" ADD COLUMN "source" TEXT;

-- CreateTable
CREATE TABLE "impact_affected_tables" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "impactItemId" TEXT NOT NULL,
    "tableName" TEXT NOT NULL,
    "columnName" TEXT,
    "columnType" TEXT,
    "changeKind" TEXT NOT NULL DEFAULT 'reference',
    "suggestedDdl" TEXT,
    "source" TEXT NOT NULL DEFAULT 'mybatis',
    "reconciliation" TEXT,
    "confidence" REAL NOT NULL DEFAULT 0.5,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "impact_affected_tables_impactItemId_fkey" FOREIGN KEY ("impactItemId") REFERENCES "impact_items" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "impact_affected_tables_impactItemId_idx" ON "impact_affected_tables"("impactItemId");
