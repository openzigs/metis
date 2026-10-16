-- Issue #1220 — import re-sync keeps analysts' edits to imported requirements.
-- Postgres twin of `server/prisma/migrations/20261021001220_issue1220_import_source_fingerprint`;
-- the reasoning and the rollback are written there. Idempotent.
--
-- Nullable TEXT / TIMESTAMP columns, and INTEGER columns with a constant default: a
-- metadata-only change on Postgres 11+, with no table rewrite.
ALTER TABLE "requirements" ADD COLUMN IF NOT EXISTS "sourceFingerprint" TEXT;

ALTER TABLE "requirements" ADD COLUMN IF NOT EXISTS "sourcePending" TEXT;

ALTER TABLE "requirements" ADD COLUMN IF NOT EXISTS "sourceDecision" TEXT;

ALTER TABLE "requirements" ADD COLUMN IF NOT EXISTS "sourceDecisionActorId" TEXT;

ALTER TABLE "requirements" ADD COLUMN IF NOT EXISTS "sourceDecidedAt" TIMESTAMP(3);

ALTER TABLE "import_runs" ADD COLUMN IF NOT EXISTS "keptLocalCount" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "import_runs" ADD COLUMN IF NOT EXISTS "divergedCount" INTEGER NOT NULL DEFAULT 0;
