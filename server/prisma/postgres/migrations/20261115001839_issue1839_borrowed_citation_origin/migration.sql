-- Issue #1839 (epic #1828) — the requirement a borrowed code link was copied
-- from (Postgres twin of
-- server/prisma/migrations/20261115001839_issue1839_borrowed_citation_origin;
-- see that file for the rationale). One nullable TEXT column, nothing
-- backfilled. Idempotent (#556).
--
-- Rollback: server/prisma/postgres/rollbacks/20261115001839_issue1839_borrowed_citation_origin.sql

ALTER TABLE "requirement_code_mappings" ADD COLUMN IF NOT EXISTS "originRequirementId" TEXT;
