-- Epic #163 — Enterprise integrations: Confluence/Jira/Projects v2/copilot-workspace/ACP.

-- AlterTable: Project — Projects v2 board mapping (Issue #108).
ALTER TABLE "projects" ADD COLUMN "githubProjectId" TEXT;
ALTER TABLE "projects" ADD COLUMN "githubProjectFieldMappings" TEXT;

-- CreateTable: ApiToken — ACP per-user bearer tokens (Issue #119).
CREATE TABLE "api_tokens" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "scopes" TEXT NOT NULL DEFAULT '[]',
    "lastUsedAt" DATETIME,
    "expiresAt" DATETIME,
    "revokedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "api_tokens_tokenHash_key" ON "api_tokens"("tokenHash");
CREATE INDEX "api_tokens_userId_idx" ON "api_tokens"("userId");
CREATE INDEX "api_tokens_revokedAt_idx" ON "api_tokens"("revokedAt");
