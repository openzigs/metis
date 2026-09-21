-- Issue #611 (epic #608) — per-user notification preferences.
--
-- Adds the `notification_preferences` table: one row per (user, channel,
-- event) cell the user has EXPLICITLY toggled. Absent row = default — the
-- default matrix lives in `server/src/lib/notifications/preferences.ts`, so
-- existing users need no backfill and this migration is data-free.
-- ADDITIVE — no existing table is altered — so it is non-destructive and
-- trivially reversible (DROP TABLE notification_preferences).

-- CreateTable
CREATE TABLE "notification_preferences" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "notification_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "notification_preferences_userId_idx" ON "notification_preferences"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "notification_preferences_userId_channel_event_key" ON "notification_preferences"("userId", "channel", "event");
