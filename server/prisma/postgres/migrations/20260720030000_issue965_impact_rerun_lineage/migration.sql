-- Issue #965 (Epic #960) — impact re-run + drift lineage (Postgres mirror).
--
-- See the SQLite migration of the same name for the full rationale. All DDL is
-- idempotent (`IF NOT EXISTS`; the FK wrapped in a pg_constraint existence
-- DO-block) so the full migration history replays cleanly over the cumulative
-- `00000000000000_init` baseline on a fresh Postgres (issue #556 guard).

-- AlterTable
ALTER TABLE "impact_analyses" ADD COLUMN IF NOT EXISTS "rerunOfId" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "impact_analyses_rerunOfId_idx" ON "impact_analyses"("rerunOfId");

-- AddForeignKey (guarded — bare ADD CONSTRAINT has no IF NOT EXISTS in Postgres)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'impact_analyses_rerunOfId_fkey') THEN
    ALTER TABLE "impact_analyses" ADD CONSTRAINT "impact_analyses_rerunOfId_fkey" FOREIGN KEY ("rerunOfId") REFERENCES "impact_analyses" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
