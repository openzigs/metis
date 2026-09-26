-- Epic #127 (#136, #137, #138, #139) — the chat transcript becomes server-owned
-- (Postgres mirror). See the SQLite migration of the same name for the full
-- rationale: the browser used to own the conversation and the server trusted
-- whatever history it resent, so earlier assistant/tool messages could be forged.
--
-- All DDL is idempotent (`IF NOT EXISTS`; the FK wrapped in a pg_constraint
-- existence DO-block) so the full history replays cleanly over the cumulative
-- `00000000000000_init` baseline on a fresh Postgres (issue #556 guard).
--
-- Rollback (documentation; rehearsed once on a scratch database built by
-- `migrate deploy`, 2026-09-26 — rehearse again on a copy before relying on it): `DROP TABLE "ai_messages";` then
-- `ALTER TABLE "ai_sessions" DROP COLUMN "forkedFromOrdinal", DROP COLUMN "forkedFromSessionId";`.
-- Lossy: every transcript written after this migration is lost; each session's
-- `snapshot` still holds its most recent in-context turns.

-- AlterTable
ALTER TABLE "ai_sessions" ADD COLUMN IF NOT EXISTS "forkedFromSessionId" TEXT,
ADD COLUMN IF NOT EXISTS "forkedFromOrdinal" INTEGER;

-- CreateTable
CREATE TABLE IF NOT EXISTS "ai_messages" (
    "id" TEXT NOT NULL,
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
    "compactedAt" TIMESTAMP(3),
    "compactedIntoId" TEXT,
    "meta" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ai_messages_sessionId_compactedAt_idx" ON "ai_messages"("sessionId", "compactedAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ai_messages_sessionId_ordinal_key" ON "ai_messages"("sessionId", "ordinal");

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ai_messages_sessionId_fkey') THEN
    EXECUTE 'ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ai_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END
$idem$;
