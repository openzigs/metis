-- Issue #591 — re-check replaced secrets that were kept because something
-- still referenced them (Postgres mirror). See the SQLite migration of the
-- same name for the full rationale. `IF NOT EXISTS` keeps the full chain
-- idempotent (issue #556).
--
-- Rollback (documentation): `ALTER TABLE "secrets" DROP COLUMN "replacedKeptAt";`
ALTER TABLE "secrets" ADD COLUMN IF NOT EXISTS "replacedKeptAt" TIMESTAMP(3);
