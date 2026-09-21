-- Issue #1096 — persist a requirement's acceptance criteria as structured data
-- (Postgres mirror).
--
-- Adds `requirements.acceptanceCriteria`. See the SQLite migration of the same
-- name for the full rationale. `IF NOT EXISTS` keeps this idempotent against the
-- cumulative init baseline, which already declares the column for a fresh
-- database (so replaying the full chain never collides — issue #556).
ALTER TABLE "requirements" ADD COLUMN IF NOT EXISTS "acceptanceCriteria" TEXT NOT NULL DEFAULT '[]';
