-- Issue #1235 — a scheduled webhook may send only a vault secret its binder may use.
--
-- The webhook handler re-judges, at fire time, the principal who set a job's
-- binding (task type, URL, project, `authHeader` vault reference). That
-- principal used to be read back from the job's `scheduled-job.update` audit
-- rows, written fire-and-forget after the job update: a lost row left fire time
-- judging an earlier binder instead of the true one. It is now stored on the job
-- itself, in the same UPDATE that writes the binding, so the two cannot drift.
--
--   webhookBinderId — the user judged for the current binding. NULL with a set
--                     `webhookBoundAt` is a binding nobody was judged for (a
--                     system write); fire time refuses it.
--   webhookBoundAt  — when that binding was judged. NULL on every existing row:
--                     those were never judged, so fire time still reads their
--                     audit trail (author plus every pre-#1235 editor). No
--                     backfill: a migration cannot know who was entitled.
--
-- The index bounds that audit-trail read: per-fire rows
-- (`scheduler.webhook.fire`, `scheduler.webhook.secret_refused`) share a job's
-- (targetType, targetId) range, and the read wants `scheduled-job.update` only.
--
-- Nullable columns and a new index: no table rewrite.
--
-- Rollback (documentation):
--   DROP INDEX "audit_logs_targetType_targetId_action_idx";
--   ALTER TABLE "scheduled_jobs" DROP COLUMN "webhookBinderId";
--   ALTER TABLE "scheduled_jobs" DROP COLUMN "webhookBoundAt";
-- After it fire time judges from the audit trail alone.
ALTER TABLE "scheduled_jobs" ADD COLUMN "webhookBinderId" TEXT;
ALTER TABLE "scheduled_jobs" ADD COLUMN "webhookBoundAt" DATETIME;

CREATE INDEX "audit_logs_targetType_targetId_action_idx" ON "audit_logs"("targetType", "targetId", "action");
