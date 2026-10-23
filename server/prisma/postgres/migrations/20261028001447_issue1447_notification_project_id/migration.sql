-- Issue #1447 — a notification records the project it is about.
-- Postgres twin of the SQLite migration; see that file
-- (server/prisma/migrations/20261028001447_issue1447_notification_project_id)
-- for the full rationale. Nullable, not a foreign key, backfilled per type.
--
-- Structural DDL is idempotent (#556), so the full history applies from empty;
-- every backfill touches only rows still NULL, so a re-run is a no-op.
--
-- The payload is read with a regex, not a `::json` cast: a cast of one
-- malformed payload would abort the whole migration, while a non-match leaves
-- that row NULL (and so redacted). Every payload is `JSON.stringify` output,
-- which writes `"key":"value"` with no whitespace around the colon.
--
-- Rollback (documentation):
--   DROP INDEX "notifications_projectId_idx";
--   ALTER TABLE "notifications" DROP COLUMN "projectId";

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "projectId" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "notifications_projectId_idx" ON "notifications"("projectId");

-- Backfill: comment @mentions
UPDATE "notifications" SET "projectId" = (
  SELECT COALESCE("r"."projectId", "ct"."specKitProjectId")
  FROM "comments" "c"
  JOIN "comment_threads" "ct" ON "ct"."id" = "c"."threadId"
  LEFT JOIN "requirements" "r" ON "r"."id" = "ct"."requirementId"
  WHERE "c"."id" = COALESCE(
    "notifications"."commentId",
    substring("notifications"."payload" from '"commentId":"([^"]+)"')
  )
)
WHERE "projectId" IS NULL AND "type" = 'mention';

-- Backfill: discussion @mentions
UPDATE "notifications" SET "projectId" = (
  SELECT "d"."projectId" FROM "discussion_threads" "d"
  WHERE "d"."id" = substring("notifications"."payload" from '"threadId":"([^"]+)"')
)
WHERE "projectId" IS NULL AND "type" = 'discussion_mention';

-- Backfill: review notifications
UPDATE "notifications" SET "projectId" = (
  SELECT "rr"."projectId" FROM "review_requests" "rr"
  WHERE "rr"."id" = substring("notifications"."payload" from '"reviewId":"([^"]+)"')
)
WHERE "projectId" IS NULL
  AND "type" IN ('review_requested', 'review_decided', 'review_approved', 'review_rejected');

-- Backfill: SLA deadline alerts
UPDATE "notifications" SET "projectId" = (
  SELECT "r"."projectId" FROM "requirements" "r"
  WHERE "r"."id" = substring("notifications"."payload" from '"requirementId":"([^"]+)"')
)
WHERE "projectId" IS NULL AND "type" = 'sla_deadline';
