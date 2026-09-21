-- Issue #853 (Epic #852) — per-project opt-in for database-aware analysis
-- (Postgres mirror).
--
-- Adds `projects.databaseAwareAnalysis` (`auto` | `on` | `off`, default
-- `auto`). See the SQLite migration of the same name for the rationale.
-- `IF NOT EXISTS` keeps this idempotent against the cumulative init
-- baseline, which already declares the column for a fresh database.
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "databaseAwareAnalysis" TEXT NOT NULL DEFAULT 'auto';
