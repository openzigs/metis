-- Issue #956 (Epic #954) — surface cross-project shared-table CONSUMERS in
-- impact-analysis results (Postgres mirror).
--
-- See the SQLite migration of the same name for the full rationale. All DDL is
-- idempotent (`IF NOT EXISTS`; the FK wrapped in a pg_constraint existence
-- DO-block) so the full migration history replays cleanly over the cumulative
-- `00000000000000_init` baseline on a fresh Postgres (issue #556 guard).

-- AlterTable
ALTER TABLE "impact_affected_tables" ADD COLUMN IF NOT EXISTS "consumerResolution" TEXT;

-- CreateTable
CREATE TABLE IF NOT EXISTS "impact_affected_table_consumers" (
    "id" TEXT NOT NULL,
    "affectedTableId" TEXT NOT NULL,
    "consumerProjectId" TEXT NOT NULL,
    "consumerProjectName" TEXT NOT NULL,
    "usage" TEXT NOT NULL DEFAULT 'readBy',
    "objectQualifiedName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "impact_affected_table_consumers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "impact_affected_table_consumers_affectedTableId_idx" ON "impact_affected_table_consumers"("affectedTableId");

-- AddForeignKey (guarded — bare ADD CONSTRAINT has no IF NOT EXISTS in Postgres)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'impact_affected_table_consumers_affectedTableId_fkey') THEN
    ALTER TABLE "impact_affected_table_consumers" ADD CONSTRAINT "impact_affected_table_consumers_affectedTableId_fkey" FOREIGN KEY ("affectedTableId") REFERENCES "impact_affected_tables" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
