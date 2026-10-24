-- Issue #1511 — a drift event is unique on (projectId, deliveryId), not on the
-- delivery id alone. Postgres twin of the SQLite migration; see that file
-- (server/prisma/migrations/20261102001511_issue1511_drift_event_project_delivery)
-- for the full rationale. No existing row can violate the new index: every
-- row's deliveryId was already unique on its own.
--
-- `IF EXISTS` / `IF NOT EXISTS` keep the full chain idempotent (#556): the
-- baseline still creates the old index, and this drops it again.
--
-- Rollback (documentation; fails once two projects share a delivery id):
--   DROP INDEX IF EXISTS "drift_events_projectId_deliveryId_key";
--   CREATE UNIQUE INDEX "drift_events_deliveryId_key" ON "drift_events"("deliveryId");

-- DropIndex
DROP INDEX IF EXISTS "drift_events_deliveryId_key";

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "drift_events_projectId_deliveryId_key" ON "drift_events"("projectId", "deliveryId");
