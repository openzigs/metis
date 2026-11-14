-- Issue #2498 — a portfolio check records which requirement rows it read.
--
-- "portfolio_assessments"."sourceRows" (TEXT, nullable): JSON array of
-- `{ id, analysisId, sourceIds }`, one per requirement row the check read when
-- it started (its single requirement, or the change request's rows its starter
-- could see), with each row's `sourceIds` as it was then. The view decides what
-- of the stored text a reader may see from these as well as from the rows that
-- exist now, so a restricted row hard-deleted since (a withheld replacement, a
-- re-synthesis) still hides what it wrote. NULL: not recorded (a statement or
-- document check, which reads no requirement row).
--
-- Backfill: every existing check started from a requirement, a change
-- request or a chosen set of requirements (#2301, "sourceRequirementIds",
-- added by the migration just before this one) records the rows that exist now (the rows the view read before this
-- migration, soft-deleted ones included), so a row hard-deleted from here on
-- still counts for it. A row hard-deleted before the migration is gone and
-- cannot be recorded. Only a NULL record is filled: re-running it changes
-- nothing.
--
-- Rollback: server/prisma/rollbacks/20261129002498_issue2498_portfolio_source_rows.sql
-- (exercised by server/tests/portfolio-source-rows-migration-2498.sqlite.test.ts).

-- AlterTable
ALTER TABLE "portfolio_assessments" ADD COLUMN "sourceRows" TEXT;

-- Backfill
UPDATE "portfolio_assessments"
SET "sourceRows" = (
  SELECT json_group_array(
    json_object('id', "r"."id", 'analysisId', "r"."analysisId", 'sourceIds', "r"."sourceIds")
  )
  FROM "requirements" AS "r"
  WHERE CASE
    WHEN "portfolio_assessments"."sourceRequirementId" IS NOT NULL
      THEN "r"."id" = "portfolio_assessments"."sourceRequirementId"
    WHEN "portfolio_assessments"."sourceAnalysisId" IS NOT NULL
      THEN "r"."analysisId" = "portfolio_assessments"."sourceAnalysisId"
    -- #2301 — a chosen set: its requirements (only a valid array reaches here).
    ELSE "r"."id" IN (SELECT "value" FROM json_each("portfolio_assessments"."sourceRequirementIds"))
  END
)
WHERE "sourceRows" IS NULL
  AND (
    "sourceRequirementId" IS NOT NULL
    OR "sourceAnalysisId" IS NOT NULL
    OR (json_valid("sourceRequirementIds") AND json_type("sourceRequirementIds") = 'array'
        AND json_array_length("sourceRequirementIds") > 0)
  );
