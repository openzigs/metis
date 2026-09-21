-- Issue #894 (Epic #882) — per-project opt-in for SQL-lineage extraction
-- (Postgres mirror).
--
-- Adds `projects.sqlLineage` (`auto` | `on` | `off`, default `auto`). See the
-- SQLite migration of the same name for the rationale. `IF NOT EXISTS` keeps
-- this idempotent against the cumulative init baseline, which already
-- declares the column for a fresh database.
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "sqlLineage" TEXT NOT NULL DEFAULT 'auto';
