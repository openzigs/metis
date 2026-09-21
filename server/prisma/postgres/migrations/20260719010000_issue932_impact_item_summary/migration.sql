-- Issue #932 (Epic #929) — persist the per-item BA-readable impact summary
-- (Postgres mirror).
--
-- Adds `impact_items.summary`. See the SQLite migration of the same name for the
-- rationale. `IF NOT EXISTS` keeps this idempotent against the cumulative init
-- baseline, which already declares the column for a fresh database (so replaying
-- the full chain never collides — issue #556).
ALTER TABLE "impact_items" ADD COLUMN IF NOT EXISTS "summary" TEXT;
