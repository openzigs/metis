-- Epic #127 (#136, #137, #138, #139) — the chat transcript becomes server-owned.
--
-- Until now the BROWSER held the conversation and resent it on every turn, and
-- the server trusted whatever history arrived — so a client could forge earlier
-- assistant or tool messages. `ai_messages` is now the authoritative transcript:
-- the chat routes accept only the new user message and read every earlier turn
-- from here.
--
--   * one row per message, `ordinal` unique per session;
--   * provider-reported token usage per reply (#137), NULL when not reported;
--   * compaction (#138) never deletes: a folded row gets `compactedAt` +
--     `compactedIntoId` and its summary is a row of its own (`kind = 'summary'`);
--   * `ai_sessions.forkedFromSessionId` / `forkedFromOrdinal` record where a
--     fork (#139) was taken. Plain columns, no FK, so deleting the source
--     session never cascades into its forks.
--
-- Additive only: no existing column changes, no data is rewritten. Sessions
-- created before this migration keep their `snapshot`; resume imports its
-- user/assistant turns into `ai_messages` the first time it is opened.
--
-- Rollback (documentation; rehearsed once on a scratch database built by
-- `migrate deploy`, 2026-09-26 — rehearse again on a copy before relying on it): `DROP TABLE "ai_messages";` then
-- `ALTER TABLE "ai_sessions" DROP COLUMN "forkedFromOrdinal";` and
-- `ALTER TABLE "ai_sessions" DROP COLUMN "forkedFromSessionId";` (SQLite 3.35+).
-- Lossy: every transcript written after this migration is lost; each session's
-- `snapshot` still holds its most recent in-context turns.

-- AlterTable
ALTER TABLE "ai_sessions" ADD COLUMN "forkedFromOrdinal" INTEGER;
ALTER TABLE "ai_sessions" ADD COLUMN "forkedFromSessionId" TEXT;

-- CreateTable
CREATE TABLE "ai_messages" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'message',
    "content" TEXT NOT NULL,
    "estimatedTokens" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "cacheReadTokens" INTEGER,
    "cacheWriteTokens" INTEGER,
    "promptChars" INTEGER,
    "provider" TEXT,
    "model" TEXT,
    "finishReason" TEXT,
    "compactedAt" DATETIME,
    "compactedIntoId" TEXT,
    "meta" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ai_messages_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ai_sessions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ai_messages_sessionId_compactedAt_idx" ON "ai_messages"("sessionId", "compactedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ai_messages_sessionId_ordinal_key" ON "ai_messages"("sessionId", "ordinal");
