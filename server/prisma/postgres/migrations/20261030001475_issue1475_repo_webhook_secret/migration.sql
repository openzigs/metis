-- Issue #1475 — per-connector GitHub webhook secret, its check, the
-- repository-binding time, and the lookup index.
-- Postgres twin of the SQLite migration; see that file
-- (server/prisma/migrations/20261030001475_issue1475_repo_webhook_secret)
-- for the full rationale. repoBoundAt is backfilled from createdAt.
--
-- Structural DDL is idempotent (#556), so the full history applies from empty.
--
-- Rollback (documentation):
--   DROP INDEX IF EXISTS "repo_connections_ownerOrOrg_repoName_idx";
--   ALTER TABLE "repo_connections" DROP COLUMN "repoBoundAt";
--   ALTER TABLE "repo_connections" DROP COLUMN "webhookSecretCheck";
--   ALTER TABLE "repo_connections" DROP COLUMN "webhookSecretNonce";

-- AlterTable
ALTER TABLE "repo_connections" ADD COLUMN IF NOT EXISTS "webhookSecretNonce" TEXT;
ALTER TABLE "repo_connections" ADD COLUMN IF NOT EXISTS "webhookSecretCheck" TEXT;
ALTER TABLE "repo_connections" ADD COLUMN IF NOT EXISTS "repoBoundAt" TIMESTAMP(3);

-- Backfill
UPDATE "repo_connections" SET "repoBoundAt" = "createdAt" WHERE "repoBoundAt" IS NULL;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "repo_connections_ownerOrOrg_repoName_idx" ON "repo_connections"("ownerOrOrg", "repoName");
