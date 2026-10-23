-- Issue #1318 — a comment @mention notification records the comment it quotes.
-- Postgres twin of the SQLite migration; see that file
-- (server/prisma/migrations/20261027001318_issue1318_notification_comment_id)
-- for the full rationale. Nullable, not a foreign key, no backfill.
--
-- Structural DDL is idempotent (#556), so the full history applies from empty.
--
-- Rollback (documentation):
--   DROP INDEX "notifications_commentId_idx";
--   ALTER TABLE "notifications" DROP COLUMN "commentId";

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "commentId" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "notifications_commentId_idx" ON "notifications"("commentId");
