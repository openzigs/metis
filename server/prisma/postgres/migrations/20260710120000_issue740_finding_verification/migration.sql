-- Issue #740 (epic #727) — per-finding verifier/critic status.
-- Postgres mirror of the SQLite migration.
--
-- Adds `findings.verificationStatus` (nullable): the deterministic verifier
-- verdict — `confirmed` (kept a grounded code citation) | `unverified` (code
-- claim dropped by the #734 gate). ADDITIVE. The ADD COLUMN is `IF NOT EXISTS`
-- (idempotent) so replaying the full migration history over the cumulative
-- `00000000000000_init` baseline (which already carries the column) on a fresh
-- Postgres no-ops here rather than colliding (issue #556 guard).
ALTER TABLE "findings" ADD COLUMN IF NOT EXISTS "verificationStatus" TEXT;
