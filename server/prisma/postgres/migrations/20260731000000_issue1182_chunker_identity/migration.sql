-- Issue #1182 — tag each knowledge chunk with the chunker generation that cut it
-- (Postgres mirror).
--
-- Adds `knowledge_chunks.chunkerIdentity`. See the SQLite migration of the same
-- name for the full rationale. `IF NOT EXISTS` keeps this idempotent against the
-- cumulative init baseline, which already declares the column for a fresh
-- database (so replaying the full chain never collides — issue #556).
ALTER TABLE "knowledge_chunks" ADD COLUMN IF NOT EXISTS "chunkerIdentity" TEXT;
