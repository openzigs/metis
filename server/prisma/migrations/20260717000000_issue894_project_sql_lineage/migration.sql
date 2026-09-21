-- Issue #894 (Epic #882) — per-project opt-in for SQL-lineage extraction.
--
-- Adds `projects.sqlLineage` (`auto` | `on` | `off`, default `auto`).
-- Mirrors `projects.databaseAwareAnalysis` (#853): replaces sole reliance on
-- the hidden global `SQL_LINEAGE_MODE` env flag with a discoverable
-- per-project intent. `auto` defers to the platform default (byte-identical
-- to pre-#894 behavior); `on`/`off` are explicit overrides. Additive/backward
-- compatible: existing rows backfill to `auto` via the column default.
ALTER TABLE "projects" ADD COLUMN "sqlLineage" TEXT NOT NULL DEFAULT 'auto';
