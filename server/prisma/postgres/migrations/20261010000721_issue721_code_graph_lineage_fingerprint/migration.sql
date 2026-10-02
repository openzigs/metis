-- Issue #721 — SQL lineage never backfilled on an already-ingested repo
-- (Postgres mirror). See the SQLite migration of the same name for the full
-- rationale. `IF NOT EXISTS` keeps the full chain idempotent (issue #556).
--
-- Rollback (documentation): `ALTER TABLE "code_graphs" DROP COLUMN "lineageFingerprint";`
ALTER TABLE "code_graphs" ADD COLUMN IF NOT EXISTS "lineageFingerprint" TEXT;
