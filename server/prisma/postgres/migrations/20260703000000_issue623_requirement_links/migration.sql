-- Issue #623 (epic #610) -- typed cross-project requirement links.
-- Postgres mirror of the SQLite migration.
--
-- Adds `requirement_links` (directional source -> target typed link, unique per
-- (source, target, type), both FKs cascade on requirement delete; `createdById`
-- is a scalar soft-link to users.id with no FK). ADDITIVE -- no existing table
-- is altered. All structural DDL is idempotent (`IF NOT EXISTS`; the FKs are
-- wrapped in pg_constraint existence DO-blocks) so the full migration history
-- replays cleanly over the cumulative `00000000000000_init` baseline on a fresh
-- Postgres (#556 guard).

-- CreateTable
CREATE TABLE IF NOT EXISTS "requirement_links" (
    "id" TEXT NOT NULL,
    "sourceRequirementId" TEXT NOT NULL,
    "targetRequirementId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "requirement_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "requirement_links_sourceRequirementId_idx" ON "requirement_links"("sourceRequirementId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "requirement_links_targetRequirementId_idx" ON "requirement_links"("targetRequirementId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "requirement_links_sourceRequirementId_targetRequirementId_type_key" ON "requirement_links"("sourceRequirementId", "targetRequirementId", "type");

-- AddForeignKey (guarded -- bare ADD CONSTRAINT has no IF NOT EXISTS in Postgres)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'requirement_links_sourceRequirementId_fkey') THEN
    ALTER TABLE "requirement_links" ADD CONSTRAINT "requirement_links_sourceRequirementId_fkey" FOREIGN KEY ("sourceRequirementId") REFERENCES "requirements"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey (guarded -- bare ADD CONSTRAINT has no IF NOT EXISTS in Postgres)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'requirement_links_targetRequirementId_fkey') THEN
    ALTER TABLE "requirement_links" ADD CONSTRAINT "requirement_links_targetRequirementId_fkey" FOREIGN KEY ("targetRequirementId") REFERENCES "requirements"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
