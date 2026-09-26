-- Issue #182 — record the outcome of every repository-source RAG ingest
-- (Postgres mirror). See the SQLite migration of the same name for the full
-- rationale. `IF NOT EXISTS` keeps the full chain idempotent (issue #556).
ALTER TABLE "repo_connections" ADD COLUMN IF NOT EXISTS "sourceIngestState" TEXT;
