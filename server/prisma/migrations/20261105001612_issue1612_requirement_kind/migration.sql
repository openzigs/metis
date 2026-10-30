-- Issue #1612 — a functional / non-functional "kind" on Requirement.
--
--   kind         `functional` | `non-functional`. Orthogonal to `type`, which is
--                the work-item shape (feature, bug, ...): a bug can be either.
--   nfrCategory  the NFR category (`NFR_CATEGORIES` in @metis/shared, e.g.
--                `performance`) of a non-functional requirement; NULL otherwise.
--
-- Both nullable TEXT, like every enum column on this table. NULL means unknown
-- and is what every existing row reads: nothing is backfilled, because a
-- guessed classification would be published as a real one.
--
-- Rollback: server/prisma/rollbacks/20261105001612_issue1612_requirement_kind.sql
-- (exercised by server/tests/requirement-kind-migration-1612.sqlite.test.ts).

-- AlterTable
ALTER TABLE "requirements" ADD COLUMN "kind" TEXT;
ALTER TABLE "requirements" ADD COLUMN "nfrCategory" TEXT;
