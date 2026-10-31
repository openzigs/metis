-- Issue #1609 — record what a multi-project impact run found for EACH of its
-- projects, so a project with no affected symbols reads "checked, nothing
-- affected" instead of vanishing from the result.
--
--   outcome        affected | checked-none-affected | not-checked | error
--   outcomeReason  restricted | no-index | timeout | budget (not-checked only)
--
-- Both live on the run's persisted project selection (#70's
-- `impact_analysis_projects`), which already holds one row per project the run
-- was started for: the same rows the detail read loads.
--
-- Not backfilled: a run finished before this change never recorded which of its
-- projects it checked. NULL means "not recorded", and the detail read lists no
-- outcome for that project.
--
-- Rollback (documentation):
--   ALTER TABLE "impact_analysis_projects" DROP COLUMN "outcomeReason";
--   ALTER TABLE "impact_analysis_projects" DROP COLUMN "outcome";

-- AlterTable
ALTER TABLE "impact_analysis_projects" ADD COLUMN "outcome" TEXT;
ALTER TABLE "impact_analysis_projects" ADD COLUMN "outcomeReason" TEXT;
