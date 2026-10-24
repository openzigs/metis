-- Issue #1475 — per-connector GitHub webhook secret nonce.
-- Postgres twin of the SQLite migration; see that file
-- (server/prisma/migrations/20261030001475_issue1475_repo_webhook_secret)
-- for the full rationale. Nullable, no backfill.
--
-- Structural DDL is idempotent (#556), so the full history applies from empty.
--
-- Rollback (documentation):
--   ALTER TABLE "repo_connections" DROP COLUMN "webhookSecretNonce";

-- AlterTable
ALTER TABLE "repo_connections" ADD COLUMN IF NOT EXISTS "webhookSecretNonce" TEXT;
