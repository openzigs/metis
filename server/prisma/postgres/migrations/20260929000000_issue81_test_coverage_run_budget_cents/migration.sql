-- Issue #81 — persist the budget cap a test-coverage run executed under
-- (Postgres mirror). See the SQLite migration of the same name for the full
-- rationale. `IF NOT EXISTS` keeps the full chain idempotent (issue #556).
ALTER TABLE "test_coverage_runs" ADD COLUMN IF NOT EXISTS "budgetCents" INTEGER;
