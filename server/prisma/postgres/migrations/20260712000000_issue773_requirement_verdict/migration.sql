-- Issue #773 — per-requirement three-state verdict (Postgres mirror).
--
-- Adds `requirements.verdict` (nullable): `implemented` | `gap-confirmed` |
-- `could-not-verify`. See the SQLite migration of the same name for the rationale.
-- `IF NOT EXISTS` keeps this idempotent against the cumulative init baseline,
-- which already declares the column for a fresh database.
ALTER TABLE "requirements" ADD COLUMN IF NOT EXISTS "verdict" TEXT;
