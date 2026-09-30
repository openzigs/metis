-- Issue #402 — repoint references to the duplicate drafts that #369 retired
-- (Postgres mirror of the SQLite migration of the same name).
--
-- 20261001000000_issue369_issue_draft_dedup_unique soft-deleted every live
-- duplicate of a (projectId, dedupHash) group, keeping one survivor. Two kinds
-- of reference could still name a retired row:
--
--   1. A live draft's "parentDraftId" (a retired epic's children). Repointed to
--      the survivor, which carries the same title in the same project.
--   2. An unfinished publish batch's "metadata".draftIds. `runBatch` filters on
--      deletedAt IS NULL, so the retired draft would be skipped silently, and
--      re-creating a batch from those ids fails createBatch's count check with
--      DRAFT_MISMATCH. Repointed to the survivor, keeping first-seen order and
--      dropping the id if the survivor is already listed. Every batch runBatch
--      can still run is repointed: runBatch refuses only archived and cancelled
--      batches, and the scheduler's `publish-batch` task can re-run a completed
--      or failed one (PR #414 panel). Archived and cancelled batches keep the
--      ids they ran with, as history.
--
-- "Soft-deleted with a live row of the same (projectId, dedupHash)" names
-- exactly #369's retirees: no application path soft-deletes an issue draft,
-- and the partial unique index allows at most one live row per key.
--
-- Not handled here, because no migration can: a group that held TWO published
-- drafts kept one and retired the other, whose GitHub issue still exists. Its
-- published_issues row still names the retired draft (it was soft-deleted, not
-- removed), so that issue stays traceable; closing the duplicate on GitHub is
-- an operator decision. Both cases need the pre-#369 generator race to have
-- happened.
--
-- Also left alone: when a retired epic's child sits in the SAME dedup group as
-- the retired epic (e.g. d_s2 -> d_s1), repointing would make the survivor its
-- own parent, so the guard skips it and the child keeps a parentDraftId that
-- names a soft-deleted row (PR #414 review). Readers filter deletedAt, so it
-- renders as parentless; like the case above it needs the pre-#369 race.
--
-- Written in a separate migration rather than folded into #369's, because a
-- database that already applied #369 would never re-run an edited file.
-- Idempotent: once repointed, nothing names a retired row.
--
-- Rollback: none needed and none possible; the old ids are not kept. Every
-- rewritten reference pointed at a soft-deleted row, which no reader can load.

-- 1. A live child of a retired draft points at the survivor instead. The
--    `<> "issue_drafts"."id"` guard keeps a row from becoming its own parent.
UPDATE "issue_drafts"
SET "parentDraftId" = (
  SELECT "k"."id"
  FROM "issue_drafts" AS "r"
  JOIN "issue_drafts" AS "k"
    ON "k"."projectId" = "r"."projectId"
   AND "k"."dedupHash" = "r"."dedupHash"
   AND "k"."deletedAt" IS NULL
  WHERE "r"."id" = "issue_drafts"."parentDraftId"
    AND "r"."deletedAt" IS NOT NULL
    AND "k"."id" <> "issue_drafts"."id"
)
WHERE "deletedAt" IS NULL
  AND "parentDraftId" IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM "issue_drafts" AS "r"
    JOIN "issue_drafts" AS "k"
      ON "k"."projectId" = "r"."projectId"
     AND "k"."dedupHash" = "r"."dedupHash"
     AND "k"."deletedAt" IS NULL
    WHERE "r"."id" = "issue_drafts"."parentDraftId"
      AND "r"."deletedAt" IS NOT NULL
      AND "k"."id" <> "issue_drafts"."id"
  );

-- 2. An unfinished batch's draftIds name the survivor instead. Both lookups
--    are scoped to the batch's own project. "metadata" is TEXT holding JSON
--    (written only by createBatch's JSON.stringify), so it round-trips through
--    jsonb; key order and whitespace may change, which JSON.parse ignores.
UPDATE "publish_batches" AS "b"
SET "metadata" = jsonb_set(
  "b"."metadata"::jsonb,
  '{draftIds}',
  (
    SELECT jsonb_agg("d"."m" ORDER BY "d"."o")
    FROM (
      SELECT COALESCE("k"."id", "e"."value") AS "m", MIN("e"."ord") AS "o"
      FROM jsonb_array_elements_text("b"."metadata"::jsonb -> 'draftIds')
        WITH ORDINALITY AS "e"("value", "ord")
      LEFT JOIN "issue_drafts" AS "r"
        ON "r"."id" = "e"."value"
       AND "r"."projectId" = "b"."projectId"
       AND "r"."deletedAt" IS NOT NULL
      LEFT JOIN "issue_drafts" AS "k"
        ON "k"."projectId" = "r"."projectId"
       AND "k"."dedupHash" = "r"."dedupHash"
       AND "k"."deletedAt" IS NULL
      GROUP BY COALESCE("k"."id", "e"."value")
    ) AS "d"
  )
)::text
WHERE "b"."status" <> 'cancelled'
  AND "b"."archived" = false
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text("b"."metadata"::jsonb -> 'draftIds') AS "e"("value")
    JOIN "issue_drafts" AS "r"
      ON "r"."id" = "e"."value"
     AND "r"."projectId" = "b"."projectId"
     AND "r"."deletedAt" IS NOT NULL
    JOIN "issue_drafts" AS "k"
      ON "k"."projectId" = "r"."projectId"
     AND "k"."dedupHash" = "r"."dedupHash"
     AND "k"."deletedAt" IS NULL
  );
