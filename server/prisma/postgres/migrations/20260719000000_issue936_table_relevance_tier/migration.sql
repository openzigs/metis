-- Issue #936 (Epic #929) — persist the LLM output-relevance tier + rationale
-- (Postgres mirror).
--
-- Adds `impact_affected_tables.relevanceTier` + `.relevanceRationale`. See the
-- SQLite migration of the same name for the rationale. `IF NOT EXISTS` keeps
-- this idempotent against the cumulative init baseline, which already declares
-- both columns for a fresh database (so replaying the full chain never
-- collides — issue #556).
ALTER TABLE "impact_affected_tables" ADD COLUMN IF NOT EXISTS "relevanceTier" TEXT;
ALTER TABLE "impact_affected_tables" ADD COLUMN IF NOT EXISTS "relevanceRationale" TEXT;
