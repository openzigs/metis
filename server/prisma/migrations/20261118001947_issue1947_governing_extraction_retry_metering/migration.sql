-- Issue #1947 (epic #1866) — governing rule extraction can be retried, and its
-- model calls are metered.
--
-- 1. "governing_document_revisions"."extractionStartedAt" (nullable DATETIME):
--    when the current extraction run began. A run's writes are fenced on it, so
--    a retried revision's earlier run cannot store its rules, and a `running`
--    row older than the stale bound may be retried (a server restart mid-run
--    otherwise leaves it `running` forever). Existing rows read null, which a
--    retry treats as stale.
-- 2. "token_usages": "projectId" becomes nullable and "workspaceId" (nullable
--    TEXT, no FK, like "userId") is added with a ("workspaceId", "createdAt")
--    index. Rule extraction reads a workspace's policy, not a project, so its
--    rows carry the workspace and no project. Every existing row keeps its
--    project and reads "workspaceId" null. SQLite cannot drop NOT NULL in
--    place, so the table is rebuilt with every row copied verbatim.
--
-- Rollback: server/prisma/rollbacks/20261118001947_issue1947_governing_extraction_retry_metering.sql
-- (exercised by server/tests/governing-extraction-retry-metering-migration-1947.sqlite.test.ts).

-- AlterTable
ALTER TABLE "governing_document_revisions" ADD COLUMN "extractionStartedAt" DATETIME;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_token_usages" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT,
    "sessionId" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "costCents" INTEGER,
    "costUsd" REAL,
    "userId" TEXT,
    "agentStep" TEXT,
    "requestTokens" TEXT,
    "workspaceId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "token_usages_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_token_usages" ("agentStep", "cacheReadTokens", "cacheWriteTokens", "costCents", "costUsd", "createdAt", "id", "inputTokens", "model", "outputTokens", "projectId", "provider", "requestTokens", "sessionId", "totalTokens", "userId") SELECT "agentStep", "cacheReadTokens", "cacheWriteTokens", "costCents", "costUsd", "createdAt", "id", "inputTokens", "model", "outputTokens", "projectId", "provider", "requestTokens", "sessionId", "totalTokens", "userId" FROM "token_usages";
DROP TABLE "token_usages";
ALTER TABLE "new_token_usages" RENAME TO "token_usages";
CREATE INDEX "token_usages_projectId_createdAt_idx" ON "token_usages"("projectId", "createdAt");
CREATE INDEX "token_usages_workspaceId_createdAt_idx" ON "token_usages"("workspaceId", "createdAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
