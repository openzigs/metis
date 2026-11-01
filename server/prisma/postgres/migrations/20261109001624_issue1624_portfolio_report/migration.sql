-- Issue #1624 — the business-analyst report of a portfolio assessment.
--
--   report   JSON object (TEXT, like every JSON column on these tables, for
--            SQLite parity): where the prose came from (`model` | `template`),
--            whether it is degraded and why, the requirement restated as
--            functional and non-functional requirements, and one functional /
--            business / stakeholder paragraph per affected product. The
--            portfolio summary itself stays in `summary`.
--
-- NOT NULL DEFAULT '{}': every existing row reads as "no report". Idempotent
-- (#556).
--
-- Rollback: server/prisma/postgres/rollbacks/20261109001624_issue1624_portfolio_report.sql

-- AlterTable
ALTER TABLE "portfolio_assessments" ADD COLUMN IF NOT EXISTS "report" TEXT NOT NULL DEFAULT '{}';
