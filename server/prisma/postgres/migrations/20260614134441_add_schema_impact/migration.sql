-- Epic #168: Database schema / DDL impact analysis (extends #159).
-- Adds schema-symbol provenance to the code graph and an affected-tables table
-- carrying suggested DDL (text only) per impact item.

-- AlterTable
ALTER TABLE "code_edges" ADD COLUMN IF NOT EXISTS "source" TEXT;

-- AlterTable
ALTER TABLE "code_symbols" ADD COLUMN IF NOT EXISTS "source" TEXT;

-- CreateTable
CREATE TABLE IF NOT EXISTS "impact_affected_tables" (
    "id" TEXT NOT NULL,
    "impactItemId" TEXT NOT NULL,
    "tableName" TEXT NOT NULL,
    "columnName" TEXT,
    "columnType" TEXT,
    "changeKind" TEXT NOT NULL DEFAULT 'reference',
    "suggestedDdl" TEXT,
    "source" TEXT NOT NULL DEFAULT 'mybatis',
    "reconciliation" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "impact_affected_tables_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "impact_affected_tables_impactItemId_idx" ON "impact_affected_tables"("impactItemId");

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'impact_affected_tables_impactItemId_fkey') THEN
    EXECUTE 'ALTER TABLE "impact_affected_tables" ADD CONSTRAINT "impact_affected_tables_impactItemId_fkey"
    FOREIGN KEY ("impactItemId") REFERENCES "impact_items"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END
$idem$;
