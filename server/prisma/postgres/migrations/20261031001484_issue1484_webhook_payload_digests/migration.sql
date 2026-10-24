-- Issue #1484 — webhook replay guard keyed on the signed body.
-- Postgres twin of the SQLite migration; see that file
-- (server/prisma/migrations/20261031001484_issue1484_webhook_payload_digests)
-- for the full rationale.
--
-- Structural DDL is idempotent (#556), so the full history applies from empty.
--
-- Rollback (documentation):
--   DROP TABLE IF EXISTS "webhook_payload_digests";

-- CreateTable
CREATE TABLE IF NOT EXISTS "webhook_payload_digests" (
    "id" TEXT NOT NULL,
    "receiver" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "bodySha256" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_payload_digests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "webhook_payload_digests_receiver_eventType_bodySha256_key" ON "webhook_payload_digests"("receiver", "eventType", "bodySha256");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "webhook_payload_digests_receivedAt_idx" ON "webhook_payload_digests"("receivedAt");
