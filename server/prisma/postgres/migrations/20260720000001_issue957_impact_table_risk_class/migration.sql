-- Issue #957 (Epic #954) — surface the deterministic DDL RISK CLASS on every
-- affected table (Postgres mirror).
--
-- Adds `impact_affected_tables.riskClass`. See the SQLite migration of the same
-- name for the full rationale. `IF NOT EXISTS` keeps this idempotent against the
-- cumulative `00000000000000_init` baseline, which already declares the column
-- for a fresh database, so replaying the full chain never collides (issue #556).
ALTER TABLE "impact_affected_tables" ADD COLUMN IF NOT EXISTS "riskClass" TEXT;
