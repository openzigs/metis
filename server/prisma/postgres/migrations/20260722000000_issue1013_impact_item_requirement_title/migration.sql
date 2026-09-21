-- Issue #1013 (Epic #999) — persist the changed requirement's own title on the
-- impact item (Postgres mirror).
--
-- Adds `impact_items.requirementTitle`. See the SQLite migration of the same
-- name for the full rationale. `IF NOT EXISTS` keeps this idempotent against the
-- cumulative init baseline, which already declares the column for a fresh
-- database (so replaying the full chain never collides — issue #556).
ALTER TABLE "impact_items" ADD COLUMN IF NOT EXISTS "requirementTitle" TEXT;
