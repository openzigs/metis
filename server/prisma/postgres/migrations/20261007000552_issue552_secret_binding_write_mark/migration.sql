-- Issue #552 — a confirmed foreign-owner vault rotation must not interleave
-- with a write that binds the same secret somewhere new (Postgres mirror). See
-- the SQLite migration of the same name for the full rationale. `IF NOT EXISTS`
-- keeps the full chain idempotent (issue #556).
--
-- Rollback (documentation): `ALTER TABLE "secrets" DROP COLUMN "bindingWriteUntil";`
ALTER TABLE "secrets" ADD COLUMN IF NOT EXISTS "bindingWriteUntil" TIMESTAMP(3);
