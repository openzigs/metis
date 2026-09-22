-- Issue #70 — persist the projects an impact-analysis run was STARTED for
-- (Postgres mirror). See the SQLite migration of the same name for the full
-- rationale: deriving a run's projects from its `impact_items` rows made every
-- run with no items yet (pending/running, failed early, zero changes) invisible
-- on `/projects/:id/impact` AND visible to every non-admin, because the access
-- filter treated "no known projects" as "visible to everyone".
--
-- All DDL is idempotent (`IF NOT EXISTS`; both FKs wrapped in pg_constraint
-- existence DO-blocks) so the full history replays cleanly over the cumulative
-- `00000000000000_init` baseline on a fresh Postgres (issue #556 guard). The
-- backfill is `ON CONFLICT DO NOTHING` for the same reason.
--
-- Rollback (DOCUMENTATION ONLY — never executed or tested; rehearse it on a copy
-- first): `DROP TABLE "impact_analysis_projects";`. Lossy only for runs that have
-- no items — every other run's membership stays re-derivable from `impact_items`,
-- which this migration never touches.

-- CreateTable
CREATE TABLE IF NOT EXISTS "impact_analysis_projects" (
    "analysisId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "impact_analysis_projects_pkey" PRIMARY KEY ("analysisId","projectId")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "impact_analysis_projects_projectId_idx" ON "impact_analysis_projects"("projectId");

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'impact_analysis_projects_analysisId_fkey') THEN
    EXECUTE 'ALTER TABLE "impact_analysis_projects" ADD CONSTRAINT "impact_analysis_projects_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "impact_analyses"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END
$idem$;

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'impact_analysis_projects_projectId_fkey') THEN
    EXECUTE 'ALTER TABLE "impact_analysis_projects" ADD CONSTRAINT "impact_analysis_projects_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END
$idem$;

-- Backfill from the item-derived projects of existing runs.
INSERT INTO "impact_analysis_projects" ("analysisId", "projectId", "createdAt")
SELECT DISTINCT "impactAnalysisId", "projectId", CURRENT_TIMESTAMP FROM "impact_items"
ON CONFLICT DO NOTHING;
