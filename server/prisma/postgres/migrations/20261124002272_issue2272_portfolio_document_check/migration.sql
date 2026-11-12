-- Issue #2272 (epic #2227) — the portfolio check reads a document's requirements
-- (Postgres twin of server/prisma/migrations/20261124002272_issue2272_portfolio_document_check;
-- see that file for the rationale). Nothing backfilled. Idempotent (#556).
--
-- Rollback: server/prisma/postgres/rollbacks/20261124002272_issue2272_portfolio_document_check.sql

ALTER TABLE "portfolio_assessments" ADD COLUMN IF NOT EXISTS "sourceDocumentId" TEXT;
ALTER TABLE "portfolio_assessments" ADD COLUMN IF NOT EXISTS "notChecked" TEXT NOT NULL DEFAULT '[]';
