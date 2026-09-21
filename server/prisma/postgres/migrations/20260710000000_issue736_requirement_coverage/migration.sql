-- Issue #736 (epic #726) — per-requirement coverage classification.
-- Postgres mirror of the SQLite migration.
--
-- Adds `requirements.coverage` (nullable): a deterministic enum computed at
-- synthesis time — `grounded_in_code` | `grounded_in_docs_only` | `no_evidence`.
-- ADDITIVE. The ADD COLUMN is `IF NOT EXISTS` (idempotent) so replaying the full
-- migration history over the cumulative `00000000000000_init` baseline (which
-- already carries the column) on a fresh Postgres no-ops here rather than
-- colliding (issue #556 guard).
ALTER TABLE "requirements" ADD COLUMN IF NOT EXISTS "coverage" TEXT;
