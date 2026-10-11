-- Issue #1051 — store the proposed columns the #791 gate kept out of an impact
-- result (Postgres mirror). See the SQLite migration of the same name for the
-- full rationale: a ruled-out proposal lived only on the in-memory result and in
-- a server log line, and was gone as soon as the run was stored.
--
-- A table of its own, not more rows in "impact_affected_tables", so nothing that
-- reads the affected tables can take a ruled-out column for a needed change.
--
-- All DDL is idempotent (`IF NOT EXISTS`; the FK is wrapped in a pg_constraint
-- existence guard) so the full history replays cleanly over the cumulative
-- `00000000000000_init` baseline on a fresh Postgres (issue #556 guard).
--
-- Rollback (documentation): `DROP TABLE "impact_column_proposals";`. Lossy only
-- for the ruled-out proposals of runs stored after this migration.

-- CreateTable
CREATE TABLE IF NOT EXISTS "impact_column_proposals" (
    "id" TEXT NOT NULL,
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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "impact_column_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "impact_column_proposals_impactItemId_idx" ON "impact_column_proposals"("impactItemId");

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'impact_column_proposals_impactItemId_fkey') THEN
    EXECUTE 'ALTER TABLE "impact_column_proposals" ADD CONSTRAINT "impact_column_proposals_impactItemId_fkey" FOREIGN KEY ("impactItemId") REFERENCES "impact_items"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END
$idem$;
