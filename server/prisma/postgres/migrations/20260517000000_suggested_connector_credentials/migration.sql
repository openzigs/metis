-- Epic #701 / Issue #703 — opt-in dev DB credential discovery (PostgreSQL).
--
-- Mirrors the SQLite migration. Boolean defaults are written as the Postgres
-- literal `false`, and the table/column quoting uses Prisma's standard
-- camelCase identifiers.

-- AlterTable: suggested_connectors
ALTER TABLE "suggested_connectors"
  ADD COLUMN IF NOT EXISTS "username"             TEXT,
  ADD COLUMN IF NOT EXISTS "passwordVaultRef"     TEXT,
  ADD COLUMN IF NOT EXISTS "devCredsDetected"     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "credentialSourceFile" TEXT,
  ADD COLUMN IF NOT EXISTS "acceptedConnectorId"  TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "suggested_connectors_acceptedConnectorId_idx"
  ON "suggested_connectors" ("acceptedConnectorId");

-- AlterTable: projects
ALTER TABLE "projects"
  ADD COLUMN IF NOT EXISTS "allowCredentialScan" BOOLEAN NOT NULL DEFAULT false;
