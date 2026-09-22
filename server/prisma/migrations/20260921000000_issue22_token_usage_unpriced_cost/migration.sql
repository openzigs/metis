-- Issue #22 — `token_usages.costCents` becomes NULLABLE so an UNPRICED model
-- can be recorded as unknown spend rather than as a price it does not have.
--
-- Before this, the column was NOT NULL DEFAULT 0 and the rate lookup fell back
-- to Claude Sonnet 4.6 rates for any unrecognised model on the `anthropic`
-- provider (a DeepSeek model reached through ANTHROPIC_BASE_URL was billed at
-- $3 / $15 per MTok), while `ai_token_usages` recorded the same model at 0.
-- NULL now means "METIS had no price for this model when the row was written";
-- the usage views show such rows separately with their token counts.
--
-- SQLite cannot relax a NOT NULL in place, so Prisma rebuilds the table (taken
-- verbatim from `prisma migrate diff`). No existing row changes value: the
-- INSERT..SELECT copies every costCents across unchanged. Rows priced by the
-- old fallback are NOT rewritten — which rows were fallback-priced is not
-- recoverable from the table.
--
-- Rollback: rebuild the table with `"costCents" INTEGER NOT NULL DEFAULT 0`,
-- copying `COALESCE("costCents", 0)` — which folds unpriced rows back into $0.
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_token_usages" (
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "token_usages_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_token_usages" ("cacheReadTokens", "cacheWriteTokens", "costCents", "createdAt", "id", "inputTokens", "model", "outputTokens", "projectId", "provider", "sessionId", "totalTokens") SELECT "cacheReadTokens", "cacheWriteTokens", "costCents", "createdAt", "id", "inputTokens", "model", "outputTokens", "projectId", "provider", "sessionId", "totalTokens" FROM "token_usages";
DROP TABLE "token_usages";
ALTER TABLE "new_token_usages" RENAME TO "token_usages";
CREATE INDEX "token_usages_projectId_createdAt_idx" ON "token_usages"("projectId", "createdAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

