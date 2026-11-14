-- Issue #2290 (follow-up from #2242) — an AI discussion reply records its
-- checked citations, as a chat reply does.
--
-- "discussion_messages"."meta" (TEXT, nullable): JSON of the reply's metadata,
-- today `{"citations":[...]}`, each citation checked against what the reply
-- retrieved or read. NULL on a human message, on a reply that cited nothing,
-- and on every existing row. Nothing is backfilled: a reply written before
-- this shows no citation list, as before.
--
-- Rollback: server/prisma/rollbacks/20261130002290_issue2290_discussion_message_meta.sql
-- (exercised by server/tests/discussion-message-meta-migration-2290.sqlite.test.ts).

-- AlterTable
ALTER TABLE "discussion_messages" ADD COLUMN "meta" TEXT;
