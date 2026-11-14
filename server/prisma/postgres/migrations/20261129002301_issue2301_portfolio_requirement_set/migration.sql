-- Issue #2301 — the portfolio check takes a chosen set of stored requirements
-- (Postgres twin of
-- server/prisma/migrations/20261129002301_issue2301_portfolio_requirement_set; see
-- that file for the rationale). Nothing backfilled. Idempotent (#556).
--
-- Rollback: server/prisma/postgres/rollbacks/20261129002301_issue2301_portfolio_requirement_set.sql

ALTER TABLE "portfolio_assessments" ADD COLUMN IF NOT EXISTS "sourceRequirementIds" TEXT NOT NULL DEFAULT '[]';
