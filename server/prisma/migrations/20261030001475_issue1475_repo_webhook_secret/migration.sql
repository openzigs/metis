-- Issue #1475 — a repository connector can carry its own GitHub webhook
-- secret, so a `pull_request` delivery is attributed to the connector whose
-- secret signed it, not to whichever project connects the same repository.
--
--   webhookSecretNonce  random nonce; the secret is HMAC(HKDF(VAULT_MASTER_KEY),
--                       connectorId + nonce) and is never stored. NULL = the
--                       connector takes deployment-signed deliveries, as before.
--
-- Nullable, no backfill: every existing connector keeps using the deployment
-- GITHUB_WEBHOOK_SECRET until a project admin generates its own secret.
--
-- Rollback (documentation):
--   ALTER TABLE "repo_connections" DROP COLUMN "webhookSecretNonce";

-- AlterTable
ALTER TABLE "repo_connections" ADD COLUMN "webhookSecretNonce" TEXT;
