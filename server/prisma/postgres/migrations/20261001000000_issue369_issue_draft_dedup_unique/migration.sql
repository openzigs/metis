-- Issue #369 — one live draft per (projectId, dedupHash) (Postgres mirror).
-- See the SQLite migration of the same name for the full rationale.
-- `IF NOT EXISTS` keeps the full chain idempotent (issue #556); the dedupe
-- UPDATE is a no-op on a second run.
--
-- Rollback: DROP INDEX IF EXISTS "issue_drafts_projectId_dedupHash_key";

-- Retire live duplicates first, or the unique index cannot be built. Before
-- #369 the generator's check-then-act claim let two concurrent runs insert the
-- same (projectId, dedupHash). Per group the survivor is a published draft if
-- there is one, else the oldest (ties broken by id); the rest are soft-deleted
-- (never hard-deleted, so their published_issues rows keep their draftId).
-- The survivor is never itself updated, so every other row sees it live
-- whatever order the rows are visited in.
UPDATE "issue_drafts"
SET "deletedAt" = CURRENT_TIMESTAMP
WHERE "deletedAt" IS NULL
  AND "dedupHash" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "issue_drafts" AS "k"
    WHERE "k"."projectId" = "issue_drafts"."projectId"
      AND "k"."dedupHash" = "issue_drafts"."dedupHash"
      AND "k"."deletedAt" IS NULL
      AND "k"."id" <> "issue_drafts"."id"
      AND (
        (CASE WHEN "k"."status" = 'published' THEN 0 ELSE 1 END)
          < (CASE WHEN "issue_drafts"."status" = 'published' THEN 0 ELSE 1 END)
        OR (
          (CASE WHEN "k"."status" = 'published' THEN 0 ELSE 1 END)
            = (CASE WHEN "issue_drafts"."status" = 'published' THEN 0 ELSE 1 END)
          AND (
            "k"."createdAt" < "issue_drafts"."createdAt"
            OR ("k"."createdAt" = "issue_drafts"."createdAt" AND "k"."id" < "issue_drafts"."id")
          )
        )
      )
  );

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "issue_drafts_projectId_dedupHash_key" ON "issue_drafts"("projectId", "dedupHash") WHERE "deletedAt" IS NULL;
