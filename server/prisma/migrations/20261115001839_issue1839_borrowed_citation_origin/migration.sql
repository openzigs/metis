-- Issue #1839 (epic #1828) — a requirement can start from a similar
-- requirement's saved code links. A borrowed link is written with
-- `source = 'similar-requirement'`, and this column names the requirement it
-- was copied from, so the copy is never read as the requirement's own
-- grounding and its origin can be shown.
--
-- Nullable TEXT, no foreign key (requirements are soft-deleted; a copy outlives
-- its origin), nothing backfilled: every existing row reads null.
--
-- Rollback: server/prisma/rollbacks/20261115001839_issue1839_borrowed_citation_origin.sql
-- (exercised by server/tests/borrow-citations-1839.sqlite.test.ts).

-- AlterTable
ALTER TABLE "requirement_code_mappings" ADD COLUMN "originRequirementId" TEXT;
