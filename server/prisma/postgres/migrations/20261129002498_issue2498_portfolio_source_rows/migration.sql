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
-- cannot be recorded. Only a NULL record is filled: idempotent (#556).
--
-- Rollback: server/prisma/postgres/rollbacks/20261129002498_issue2498_portfolio_source_rows.sql

ALTER TABLE "portfolio_assessments" ADD COLUMN IF NOT EXISTS "sourceRows" TEXT;

UPDATE "portfolio_assessments" AS "pa"
SET "sourceRows" = COALESCE(
  (
    SELECT json_agg(
      json_build_object('id', "r"."id", 'analysisId', "r"."analysisId", 'sourceIds', "r"."sourceIds")
      ORDER BY "r"."id"
    )::text
    FROM "requirements" AS "r"
    WHERE CASE
      WHEN "pa"."sourceRequirementId" IS NOT NULL THEN "r"."id" = "pa"."sourceRequirementId"
      WHEN "pa"."sourceAnalysisId" IS NOT NULL THEN "r"."analysisId" = "pa"."sourceAnalysisId"
      -- #2301 — a chosen set: its requirements (only a valid array reaches here).
      ELSE "r"."id" IN (SELECT json_array_elements_text("pa"."sourceRequirementIds"::json))
    END
  ),
  '[]'
)
WHERE "pa"."sourceRows" IS NULL
  AND (
    "pa"."sourceRequirementId" IS NOT NULL
    OR "pa"."sourceAnalysisId" IS NOT NULL
    OR ("pa"."sourceRequirementIds" IS JSON ARRAY AND "pa"."sourceRequirementIds" <> '[]')
  );
