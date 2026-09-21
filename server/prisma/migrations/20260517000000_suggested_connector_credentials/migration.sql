-- Epic #701 / Issue #703 — opt-in dev DB credential discovery.
--
-- Adds:
--   * SuggestedConnector.username             — discovered username (plaintext OK)
--   * SuggestedConnector.passwordVaultRef     — vault id of dev password
--   * SuggestedConnector.devCredsDetected     — true when discovery extracted creds
--   * SuggestedConnector.credentialSourceFile — repo-relative path of source file
--   * SuggestedConnector.acceptedConnectorId  — forward link to DatabaseConnection
--   * Project.allowCredentialScan             — per-project opt-in flag (default false)

-- AlterTable
ALTER TABLE "suggested_connectors" ADD COLUMN "username" TEXT;
ALTER TABLE "suggested_connectors" ADD COLUMN "passwordVaultRef" TEXT;
ALTER TABLE "suggested_connectors" ADD COLUMN "devCredsDetected" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "suggested_connectors" ADD COLUMN "credentialSourceFile" TEXT;
ALTER TABLE "suggested_connectors" ADD COLUMN "acceptedConnectorId" TEXT;

-- CreateIndex
CREATE INDEX "suggested_connectors_acceptedConnectorId_idx" ON "suggested_connectors"("acceptedConnectorId");

-- AlterTable
ALTER TABLE "projects" ADD COLUMN "allowCredentialScan" BOOLEAN NOT NULL DEFAULT false;
