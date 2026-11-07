-- Issue #1870 (epic #1866) — a governing revision's rule-extraction error and
-- dropped-rule count (Postgres twin of
-- server/prisma/migrations/20261117001870_issue1870_governing_rule_extraction;
-- see that file for the rationale). Nothing backfilled. Idempotent (#556).
--
-- Rollback: server/prisma/postgres/rollbacks/20261117001870_issue1870_governing_rule_extraction.sql

ALTER TABLE "governing_document_revisions" ADD COLUMN IF NOT EXISTS "extractionError" TEXT;
ALTER TABLE "governing_document_revisions" ADD COLUMN IF NOT EXISTS "droppedUnverified" INTEGER NOT NULL DEFAULT 0;
