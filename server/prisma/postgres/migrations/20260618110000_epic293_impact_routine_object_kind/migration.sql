-- Epic #293 Phase 2 (#302) — surface procedures & functions in impact output.
-- Postgres mirror of the SQLite migration: adds the `objectKind` discriminator
-- to impact_affected_tables (default 'table') so a routine reached via an
-- `executes` edge is distinguishable from a table/column. Additive; no data loss.
ALTER TABLE "impact_affected_tables" ADD COLUMN IF NOT EXISTS "objectKind" TEXT NOT NULL DEFAULT 'table';
