-- Issue #1484 — webhook replay guard keyed on the signed body.
--
-- GitHub's X-Hub-Signature-256 (and Jira's) covers the request body only. The
-- X-GitHub-Delivery id and the X-Webhook-Timestamp header are unsigned, so a
-- captured delivery could be resent with a new id and timestamp and was
-- processed again. Each accepted delivery now also claims
-- (receiver, eventType, SHA-256 of the raw body); a second claim inside the
-- retention window is acknowledged as a duplicate and not processed.
--
-- Rows are purged hourly by the PR-review worker once older than the
-- retention window, so the table stays bounded.
--
-- Rollback (documentation):
--   DROP TABLE "webhook_payload_digests";

-- CreateTable
CREATE TABLE "webhook_payload_digests" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "receiver" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "bodySha256" TEXT NOT NULL,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "webhook_payload_digests_receiver_eventType_bodySha256_key" ON "webhook_payload_digests"("receiver", "eventType", "bodySha256");

-- CreateIndex
CREATE INDEX "webhook_payload_digests_receivedAt_idx" ON "webhook_payload_digests"("receivedAt");
