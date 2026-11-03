-- Issue #1725 — the host product of a portfolio assessment.
--
--   hostProductId   the product the starter chose to build the requirement
--                   (`POST /api/portfolio-assessments` `hostProductId`). The
--                   impact walk starts from it, and the page names it. A scalar
--                   soft-link with no foreign key, like `productIds`, so the
--                   record outlives the product.
--
-- Nullable TEXT: every existing row reads as "no host chosen". Nothing is
-- backfilled: a run before this migration did not store its host anywhere.
--
-- Rollback: server/prisma/rollbacks/20261111001725_issue1725_portfolio_host_product.sql
-- (exercised by server/tests/portfolio-host-migration-1725.sqlite.test.ts).

-- AlterTable
ALTER TABLE "portfolio_assessments" ADD COLUMN "hostProductId" TEXT;
