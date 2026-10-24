-- Issue #1475 — GitHub pull request deliveries belong to the registration that
-- signed them, not to whichever project connects the same repository.
--
--   webhookSecretNonce  random nonce of the connector's own webhook secret; the
--                       secret is HMAC(HKDF(VAULT_MASTER_KEY), connectorId + nonce)
--                       and is never stored. NULL = no own secret, as before.
--   webhookSecretCheck  non-secret check of that derivation: a mismatch (the
--                       master key rotated, or the id changed on import) shows
--                       the connector as needing a new secret.
--   repoBoundAt         when the connector began naming its current repository;
--                       the earliest live, connected GitHub connector takes the
--                       deliveries signed with the shared GITHUB_WEBHOOK_SECRET.
--                       Backfilled from createdAt.
--
-- The index serves the receiver's lookup by repository.
--
-- Rollback (documentation):
--   DROP INDEX "repo_connections_ownerOrOrg_repoName_idx";
--   ALTER TABLE "repo_connections" DROP COLUMN "repoBoundAt";
--   ALTER TABLE "repo_connections" DROP COLUMN "webhookSecretCheck";
--   ALTER TABLE "repo_connections" DROP COLUMN "webhookSecretNonce";

-- AlterTable
ALTER TABLE "repo_connections" ADD COLUMN "webhookSecretNonce" TEXT;
ALTER TABLE "repo_connections" ADD COLUMN "webhookSecretCheck" TEXT;
ALTER TABLE "repo_connections" ADD COLUMN "repoBoundAt" DATETIME;

-- Backfill
UPDATE "repo_connections" SET "repoBoundAt" = "createdAt" WHERE "repoBoundAt" IS NULL;

-- CreateIndex
CREATE INDEX "repo_connections_ownerOrOrg_repoName_idx" ON "repo_connections"("ownerOrOrg", "repoName");
