-- Issue #70 — persist the projects an impact-analysis run was STARTED for.
--
-- `listImpactAnalyses` derived a run's projects from its `impact_items` rows.
-- Those rows only appear once the run has mapped a change to code, so a run that
-- is pending/running, that failed before its first item, or that extracted zero
-- changes named no project at all. Two consequences: the run was invisible on
-- `/projects/:id/impact`, and the access filter's "no known projects" arm showed
-- it to EVERY non-admin caller, including members with no access to the projects
-- it was started for.
--
-- The selection is now written in the same `create` as the run itself, so the
-- list view never depends on work the run has not done yet. `impact_items`
-- remains the basis for the per-project detail view.
--
-- The backfill gives existing runs the projects their items already name, so a
-- historical run keeps listing on its project page from the new column rather
-- than only from the legacy item-derived fallback. Runs with no items keep none:
-- which projects they were started for is not recoverable from this database,
-- and inventing one would be worse than the honest empty set (they simply stop
-- being visible to non-admins, which is the fix).
--
-- Rollback (DOCUMENTATION ONLY — never executed or tested; rehearse it on a copy
-- of dev.db before relying on it): `DROP TABLE "impact_analysis_projects";`. It
-- is lossy only for runs that have no items — every other run's membership is
-- re-derivable from `impact_items`, which this migration never touches.

-- CreateTable
CREATE TABLE "impact_analysis_projects" (
    "analysisId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("analysisId", "projectId"),
    CONSTRAINT "impact_analysis_projects_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "impact_analyses" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "impact_analysis_projects_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "impact_analysis_projects_projectId_idx" ON "impact_analysis_projects"("projectId");

-- Backfill from the item-derived projects of existing runs.
INSERT INTO "impact_analysis_projects" ("analysisId", "projectId", "createdAt")
SELECT DISTINCT "impactAnalysisId", "projectId", CURRENT_TIMESTAMP FROM "impact_items";
