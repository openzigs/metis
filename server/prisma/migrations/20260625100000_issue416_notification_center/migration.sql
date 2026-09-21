-- Issue #416 — Persisted in-app notifications (mention + SLA deadline).
--
-- Adds a `notifications` table that stores per-user notification rows written
-- by `mentions.ts` (comment:mention) and `sla-checker.ts` (sla:deadline_expired)
-- alongside the existing socket emits.  The table is additive — no existing
-- table is altered — so this migration is non-destructive and trivially
-- reversible (DROP TABLE notifications).

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "href" TEXT,
    "payload" TEXT,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "notifications_userId_idx" ON "notifications"("userId");

-- CreateIndex
CREATE INDEX "notifications_userId_read_idx" ON "notifications"("userId", "read");
