-- Issue #966 (Epic #960) — BA relevance feedback on affected tables (Postgres
-- mirror). See the SQLite migration of the same name for the full rationale.
-- All DDL is idempotent (`IF NOT EXISTS`; the FK wrapped in a pg_constraint
-- existence DO-block) so the full migration history replays cleanly over the
-- cumulative `00000000000000_init` baseline on a fresh Postgres (issue #556
-- guard).

-- CreateTable
CREATE TABLE IF NOT EXISTS "impact_table_feedback" (
    "id" TEXT NOT NULL,
    "impactAnalysisId" TEXT NOT NULL,
    "impactItemId" TEXT NOT NULL,
    "tableName" TEXT NOT NULL,
    "columnName" TEXT,
    "verdict" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "userDisplayName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "impact_table_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "impact_table_feedback_impactItemId_tableName_columnName_userId_key" ON "impact_table_feedback"("impactItemId", "tableName", "columnName", "userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "impact_table_feedback_impactAnalysisId_idx" ON "impact_table_feedback"("impactAnalysisId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "impact_table_feedback_impactItemId_idx" ON "impact_table_feedback"("impactItemId");

-- AddForeignKey (guarded — bare ADD CONSTRAINT has no IF NOT EXISTS in Postgres)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'impact_table_feedback_impactItemId_fkey') THEN
    ALTER TABLE "impact_table_feedback" ADD CONSTRAINT "impact_table_feedback_impactItemId_fkey" FOREIGN KEY ("impactItemId") REFERENCES "impact_items" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
