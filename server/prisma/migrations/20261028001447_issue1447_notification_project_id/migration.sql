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
-- Each is an `UPDATE ... FROM` join, so only a row whose target resolves to a
-- project is written: an unresolvable row is left alone (still NULL), never
-- rewritten. `json_extract` reads the TOP-LEVEL key only, and `json_valid`
-- guards it: a malformed payload is skipped, never a failed migration. The
-- index is built after the backfill, over the final values.
--
-- Rollback (documentation):
--   DROP INDEX "notifications_projectId_idx";
--   ALTER TABLE "notifications" DROP COLUMN "projectId";

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN "projectId" TEXT;

-- Backfill: comment @mentions
UPDATE "notifications" SET "projectId" = "src"."projectId"
FROM (
  SELECT "c"."id" AS "commentId", COALESCE("r"."projectId", "ct"."specKitProjectId") AS "projectId"
  FROM "comments" "c"
  JOIN "comment_threads" "ct" ON "ct"."id" = "c"."threadId"
  LEFT JOIN "requirements" "r" ON "r"."id" = "ct"."requirementId"
  WHERE COALESCE("r"."projectId", "ct"."specKitProjectId") IS NOT NULL
) AS "src"
WHERE "notifications"."projectId" IS NULL
  AND "notifications"."type" = 'mention'
  AND "src"."commentId" = COALESCE(
    "notifications"."commentId",
    CASE WHEN json_valid("notifications"."payload")
      THEN json_extract("notifications"."payload", '$.commentId') END
  );

-- Backfill: discussion @mentions
UPDATE "notifications" SET "projectId" = "d"."projectId"
FROM "discussion_threads" AS "d"
WHERE "notifications"."projectId" IS NULL
  AND "notifications"."type" = 'discussion_mention'
  AND "d"."id" = CASE WHEN json_valid("notifications"."payload")
    THEN json_extract("notifications"."payload", '$.threadId') END;

-- Backfill: review notifications
UPDATE "notifications" SET "projectId" = "rr"."projectId"
FROM "review_requests" AS "rr"
WHERE "notifications"."projectId" IS NULL
  AND "notifications"."type" IN ('review_requested', 'review_decided', 'review_approved', 'review_rejected')
  AND "rr"."id" = CASE WHEN json_valid("notifications"."payload")
    THEN json_extract("notifications"."payload", '$.reviewId') END;

-- Backfill: SLA deadline alerts
UPDATE "notifications" SET "projectId" = "r"."projectId"
FROM "requirements" AS "r"
WHERE "notifications"."projectId" IS NULL
  AND "notifications"."type" = 'sla_deadline'
  AND "r"."id" = CASE WHEN json_valid("notifications"."payload")
    THEN json_extract("notifications"."payload", '$.requirementId') END;

-- CreateIndex (after the backfill)
CREATE INDEX "notifications_projectId_idx" ON "notifications"("projectId");
