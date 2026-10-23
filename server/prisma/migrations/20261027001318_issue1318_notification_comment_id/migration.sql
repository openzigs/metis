-- Issue #1318 — a comment @mention notification quotes the comment, so the row
-- records which comment it quotes. Editing the comment rewrites the stored
-- excerpt; deleting it replaces the excerpt with "The comment was deleted."
--
-- Nullable and not a foreign key: comments are soft-deleted, and the
-- notification (title and link) outlives that. No backfill: rows written before
-- this change carry no comment text (their message named only the author and
-- the requirement), so there is nothing to retract from them.
--
-- Rollback (documentation):
--   DROP INDEX "notifications_commentId_idx";
--   ALTER TABLE "notifications" DROP COLUMN "commentId";

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN "commentId" TEXT;

-- CreateIndex
CREATE INDEX "notifications_commentId_idx" ON "notifications"("commentId");
