-- Issue #1624 — the business-analyst report of a portfolio assessment.
--
--   report   JSON object (TEXT, like every JSON column on these tables): where
--            the prose came from (`model` | `template`), whether it is degraded
--            and why, the requirement restated as functional and
--            non-functional requirements, and one functional / business /
--            stakeholder paragraph per affected product. The portfolio summary
--            itself stays in `summary`.
--
-- NOT NULL DEFAULT '{}': every existing row reads as "no report", which the
-- read path treats exactly like a missing one. Nothing is backfilled: a report
-- for an old run would have to be generated, not migrated.
--
-- Rollback: server/prisma/rollbacks/20261109001624_issue1624_portfolio_report.sql
-- (exercised by server/tests/portfolio-report-migration-1624.sqlite.test.ts).

-- AlterTable
ALTER TABLE "portfolio_assessments" ADD COLUMN "report" TEXT NOT NULL DEFAULT '{}';
