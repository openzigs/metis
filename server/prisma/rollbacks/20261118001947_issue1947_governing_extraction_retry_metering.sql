-- Reverse of server/prisma/migrations/20261118001947_issue1947_governing_extraction_retry_metering
-- (SQLite). Prisma Migrate has no down migrations, so this is applied by hand:
--
--   sqlite3 <db file> < server/prisma/rollbacks/20261118001947_issue1947_governing_extraction_retry_metering.sql
--
-- Drops "governing_document_revisions"."extractionStartedAt", and rebuilds
-- "token_usages" in its pre-#1947 shape: "projectId" NOT NULL again, no
-- "workspaceId". A workspace-level row (no project) cannot exist in that shape,
-- so those rows are DELETED first. What is lost: the metered spend of governing
-- rule extraction, and when each revision's extraction run began. Every other
-- column of every other row is copied verbatim, and the migration is
-- forgotten, so a later `prisma migrate deploy` applies it again.
-- server/tests/governing-extraction-retry-metering-migration-1947.sqlite.test.ts
-- runs up, this, and up again over seeded rows.

-- One transaction: if the DELETE of the migration row failed, the tables would
-- be in their old shape while the migration still read as applied. Foreign keys
-- are off for the rebuild (SQLite ignores the pragma inside a transaction, so
-- it is set first).
PRAGMA foreign_keys=OFF;
BEGIN;
ALTER TABLE "governing_document_revisions" DROP COLUMN "extractionStartedAt";
DELETE FROM "token_usages" WHERE "projectId" IS NULL;
CREATE TABLE "old_token_usages" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "token_usages_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "old_token_usages" ("agentStep", "cacheReadTokens", "cacheWriteTokens", "costCents", "costUsd", "createdAt", "id", "inputTokens", "model", "outputTokens", "projectId", "provider", "requestTokens", "sessionId", "totalTokens", "userId") SELECT "agentStep", "cacheReadTokens", "cacheWriteTokens", "costCents", "costUsd", "createdAt", "id", "inputTokens", "model", "outputTokens", "projectId", "provider", "requestTokens", "sessionId", "totalTokens", "userId" FROM "token_usages";
DROP TABLE "token_usages";
ALTER TABLE "old_token_usages" RENAME TO "token_usages";
CREATE INDEX "token_usages_projectId_createdAt_idx" ON "token_usages"("projectId", "createdAt");
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261118001947_issue1947_governing_extraction_retry_metering';
COMMIT;
PRAGMA foreign_keys=ON;
