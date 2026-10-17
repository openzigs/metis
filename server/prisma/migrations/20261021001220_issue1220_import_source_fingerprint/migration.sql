-- Issue #1220 — import re-sync keeps analysts' edits to imported requirements.
--
-- Re-sync used to rewrite every imported requirement whose local text differed
-- from the source, so an analyst's edit was put back on the next sync even when
-- the source issue had not changed. To tell "the source changed" from "the
-- local copy was edited", each imported row now remembers the source content it
-- was last synced to, as a fingerprint (`server/src/lib/importers/source-sync.ts`).
--
--   sourceFingerprint — fingerprint of title, body, type, priority and labels
--                       at the last sync. NULL on every existing row: those
--                       predate it. The next re-sync records it when the row
--                       equals its source, and flags the row "diverged" (keeps
--                       the local copy) when it does not. No backfill: a
--                       migration cannot know what the source said back then.
--   sourcePending     — JSON of the source's newer content while the row is
--                       diverged; NULL when it is not.
--   sourceDecision    — JSON of the analyst's last "take the source version" /
--                       "keep mine" answer, shown in History.
--   sourceDecisionActorId, sourceDecidedAt
--                     — who gave that answer, and when. "Keep mine" writes no
--                       version row (the text is unchanged, so an approved
--                       review stays current); the #769 replacement guard
--                       reads this column as a person's review work instead.
--
-- And the run summary counts what re-sync kept and left diverged.
--
-- Nullable columns, and integer columns with a constant default: no rewrite.
--
-- Rollback (documentation):
--   ALTER TABLE "requirements" DROP COLUMN "sourceFingerprint";
--   ALTER TABLE "requirements" DROP COLUMN "sourcePending";
--   ALTER TABLE "requirements" DROP COLUMN "sourceDecision";
--   ALTER TABLE "requirements" DROP COLUMN "sourceDecisionActorId";
--   ALTER TABLE "requirements" DROP COLUMN "sourceDecidedAt";
--   ALTER TABLE "import_runs" DROP COLUMN "keptLocalCount";
--   ALTER TABLE "import_runs" DROP COLUMN "divergedCount";
-- After it re-sync is "source wins" again.
ALTER TABLE "requirements" ADD COLUMN "sourceFingerprint" TEXT;
ALTER TABLE "requirements" ADD COLUMN "sourcePending" TEXT;
ALTER TABLE "requirements" ADD COLUMN "sourceDecision" TEXT;
ALTER TABLE "requirements" ADD COLUMN "sourceDecisionActorId" TEXT;
ALTER TABLE "requirements" ADD COLUMN "sourceDecidedAt" DATETIME;
ALTER TABLE "import_runs" ADD COLUMN "keptLocalCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "import_runs" ADD COLUMN "divergedCount" INTEGER NOT NULL DEFAULT 0;
