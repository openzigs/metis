-- Issue #2301 — the portfolio check takes a chosen set of stored requirements
-- (`requirementIds` on POST /api/portfolio-assessments), each checked on its own.
--
-- "portfolio_assessments"."sourceRequirementIds" (TEXT NOT NULL DEFAULT '[]'):
-- a JSON string[] of the requirements chosen, in the order chosen, so the
-- host-picker link re-opens such a check on the same set. Scalar soft-links,
-- no FK, like "sourceDocumentId": the record outlives a deleted requirement.
-- Every requirement of a set is in the check's "sourceProjectId" (the start
-- request refuses a set across projects), so the read rule is unchanged. Every
-- existing row reads '[]': no check before #2301 was started from a set.
--
-- Rollback: server/prisma/rollbacks/20261129002301_issue2301_portfolio_requirement_set.sql
-- (exercised by server/tests/portfolio-requirement-set-migration-2301.sqlite.test.ts).

-- AlterTable
ALTER TABLE "portfolio_assessments" ADD COLUMN "sourceRequirementIds" TEXT NOT NULL DEFAULT '[]';
