-- Issue #1447 — a notification records the project it is about.
-- Postgres twin of the SQLite migration; see that file
-- (server/prisma/migrations/20261028001447_issue1447_notification_project_id)
-- for the full rationale. Nullable, not a foreign key, backfilled per type.
--
-- Structural DDL is idempotent (#556), so the full history applies from empty;
-- every backfill touches only rows still NULL whose target resolves to a
-- project (`UPDATE ... FROM` join), so an unresolvable row is never rewritten
-- and a re-run is a no-op. The index is built after the backfill.
--
-- The payload is read with a regex, not a `::json` cast: a cast of one
-- malformed payload would abort the whole migration, while a non-match leaves
-- that row NULL (and so redacted). Every payload is `JSON.stringify` output of
-- a flat object, which writes a top-level key as `{"key":"value"` or
-- `,"key":"value"`. The pattern is anchored on that `{` or `,`, and a string
-- value cannot imitate it: inside one, `JSON.stringify` writes every `"` as
-- `\"` (pinned by notification-project-1447-postgres.integration.test.ts).
--
-- Rollback (documentation):
--   DROP INDEX "notifications_projectId_idx";
--   ALTER TABLE "notifications" DROP COLUMN "projectId";

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "projectId" TEXT;

-- Backfill: comment @mentions
UPDATE "notifications" AS "n" SET "projectId" = "src"."projectId"
FROM (
  SELECT "c"."id" AS "commentId", COALESCE("r"."projectId", "ct"."specKitProjectId") AS "projectId"
  FROM "comments" "c"
  JOIN "comment_threads" "ct" ON "ct"."id" = "c"."threadId"
  LEFT JOIN "requirements" "r" ON "r"."id" = "ct"."requirementId"
  WHERE COALESCE("r"."projectId", "ct"."specKitProjectId") IS NOT NULL
) AS "src"
WHERE "n"."projectId" IS NULL
  AND "n"."type" = 'mention'
  AND "src"."commentId" = COALESCE(
    "n"."commentId",
    substring("n"."payload" from '[{,]"commentId":"([^"\\]+)"')
  );

-- Backfill: discussion @mentions
UPDATE "notifications" AS "n" SET "projectId" = "d"."projectId"
FROM "discussion_threads" AS "d"
WHERE "n"."projectId" IS NULL
  AND "n"."type" = 'discussion_mention'
  AND "d"."id" = substring("n"."payload" from '[{,]"threadId":"([^"\\]+)"');

-- Backfill: review notifications
UPDATE "notifications" AS "n" SET "projectId" = "rr"."projectId"
FROM "review_requests" AS "rr"
WHERE "n"."projectId" IS NULL
  AND "n"."type" IN ('review_requested', 'review_decided', 'review_approved', 'review_rejected')
  AND "rr"."id" = substring("n"."payload" from '[{,]"reviewId":"([^"\\]+)"');

-- Backfill: SLA deadline alerts
UPDATE "notifications" AS "n" SET "projectId" = "r"."projectId"
FROM "requirements" AS "r"
WHERE "n"."projectId" IS NULL
  AND "n"."type" = 'sla_deadline'
  AND "r"."id" = substring("n"."payload" from '[{,]"requirementId":"([^"\\]+)"');

-- CreateIndex (after the backfill)
CREATE INDEX IF NOT EXISTS "notifications_projectId_idx" ON "notifications"("projectId");
