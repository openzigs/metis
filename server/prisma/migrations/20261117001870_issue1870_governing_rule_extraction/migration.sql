-- Issue #1870 (epic #1866) — rule extraction from a governing revision records
-- why it failed and how many rules it dropped. A rule whose clause excerpt is
-- not found verbatim in the revision's text is never stored with an invented
-- citation; it is dropped and counted here.
--
-- Two columns on "governing_document_revisions": a nullable TEXT error and an
-- INTEGER count defaulting to 0. Nothing backfilled: every existing row reads
-- null and 0.
--
-- Rollback: server/prisma/rollbacks/20261117001870_issue1870_governing_rule_extraction.sql
-- (exercised by server/tests/governing-rule-extraction-migration-1870.sqlite.test.ts).

-- AlterTable
ALTER TABLE "governing_document_revisions" ADD COLUMN "extractionError" TEXT;
ALTER TABLE "governing_document_revisions" ADD COLUMN "droppedUnverified" INTEGER NOT NULL DEFAULT 0;
