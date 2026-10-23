-- Issue #1447 — a notification records the project it is about, so every read
-- can re-check the reader's CURRENT access to it and redact a row they can no
-- longer open (removed from the workspace, project moved or soft-deleted).
--
-- Nullable and not a foreign key: the row outlives the project's deletion and
-- is then redacted. A row this backfill cannot resolve stays NULL and is
-- redacted for every reader (fail closed).
--
-- Backfill, one statement per notification type, each from the record the row
-- points at (never from a project id echoed into the payload):
--   mention             commentId (column since #1318, else payload) -> comment
--                       -> comment thread -> requirement's project, or the Spec
--                       Kit thread's project
--   discussion_mention  payload.threadId -> discussion thread's project
--   review_*            payload.reviewId -> review request's project
--   sla_deadline        payload.requirementId -> requirement's project
-- `json_valid` guards every `json_extract`: a malformed payload is skipped
-- (left NULL, so redacted), never a failed migration.
--
-- Rollback (documentation):
--   DROP INDEX "notifications_projectId_idx";
--   ALTER TABLE "notifications" DROP COLUMN "projectId";

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN "projectId" TEXT;

-- CreateIndex
CREATE INDEX "notifications_projectId_idx" ON "notifications"("projectId");

-- Backfill: comment @mentions
UPDATE "notifications" SET "projectId" = (
  SELECT COALESCE("r"."projectId", "ct"."specKitProjectId")
  FROM "comments" "c"
  JOIN "comment_threads" "ct" ON "ct"."id" = "c"."threadId"
  LEFT JOIN "requirements" "r" ON "r"."id" = "ct"."requirementId"
  WHERE "c"."id" = COALESCE(
    "notifications"."commentId",
    CASE WHEN json_valid("notifications"."payload")
      THEN json_extract("notifications"."payload", '$.commentId') END
  )
)
WHERE "projectId" IS NULL AND "type" = 'mention';

-- Backfill: discussion @mentions
UPDATE "notifications" SET "projectId" = (
  SELECT "d"."projectId" FROM "discussion_threads" "d"
  WHERE "d"."id" = CASE WHEN json_valid("notifications"."payload")
    THEN json_extract("notifications"."payload", '$.threadId') END
)
WHERE "projectId" IS NULL AND "type" = 'discussion_mention';

-- Backfill: review notifications
UPDATE "notifications" SET "projectId" = (
  SELECT "rr"."projectId" FROM "review_requests" "rr"
  WHERE "rr"."id" = CASE WHEN json_valid("notifications"."payload")
    THEN json_extract("notifications"."payload", '$.reviewId') END
)
WHERE "projectId" IS NULL
  AND "type" IN ('review_requested', 'review_decided', 'review_approved', 'review_rejected');

-- Backfill: SLA deadline alerts
UPDATE "notifications" SET "projectId" = (
  SELECT "r"."projectId" FROM "requirements" "r"
  WHERE "r"."id" = CASE WHEN json_valid("notifications"."payload")
    THEN json_extract("notifications"."payload", '$.requirementId') END
)
WHERE "projectId" IS NULL AND "type" = 'sla_deadline';
