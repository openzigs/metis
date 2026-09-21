-- Epic #293 Phase 2 (#302) — surface procedures & functions in impact output.
-- Adds the `objectKind` discriminator to impact_affected_tables so a routine
-- (procedure/function) reached via an `executes` edge can be distinguished from
-- a table/column. Defaults to 'table' so existing rows and readers are
-- unaffected. No data is dropped; routines are NEVER auto-recommended for drop.
ALTER TABLE "impact_affected_tables" ADD COLUMN "objectKind" TEXT NOT NULL DEFAULT 'table';
