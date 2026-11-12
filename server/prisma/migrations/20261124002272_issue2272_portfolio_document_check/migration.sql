-- Issue #2272 (epic #2227) — the portfolio check reads a document's requirements,
-- and lists what it did not check.
--
-- 1. "portfolio_assessments"."sourceDocumentId" (nullable TEXT, no FK, like
--    "productIds" and "hostProductId"): the document whose requirements the
--    check read, so the record outlives the document. Null for a typed
--    statement or a requirement.
-- 2. "portfolio_assessments"."notChecked" (TEXT NOT NULL DEFAULT '[]'): a JSON
--    array of what the check did not check, each with why (a requirement past
--    the cap, text past a length, a section the model could not read, a repo
--    the budget ran out before). Every existing row reads '[]': before #2272 a
--    cut was silent, so there is nothing to backfill.
--
-- Rollback: server/prisma/rollbacks/20261124002272_issue2272_portfolio_document_check.sql
-- (exercised by server/tests/portfolio-document-check-migration-2272.sqlite.test.ts).

-- AlterTable
ALTER TABLE "portfolio_assessments" ADD COLUMN "sourceDocumentId" TEXT;
ALTER TABLE "portfolio_assessments" ADD COLUMN "notChecked" TEXT NOT NULL DEFAULT '[]';
