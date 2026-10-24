-- Issue #1511 — a drift event is unique on (projectId, deliveryId), not on the
-- delivery id alone.
--
-- GitHub gives ONE `X-GitHub-Delivery` GUID to every webhook subscribed to an
-- event. When two projects' issue hooks (the deployment hook and a connector's
-- own, or two connectors' own) received the same event, the second project's
-- drift event collided with the first on `drift_events_deliveryId_key` and was
-- dropped as a duplicate. A delivery is still recorded once per project: a
-- retry, or a second hook reaching the SAME project, still collides here.
--
-- No existing row can violate the new index: every row's deliveryId was
-- already unique on its own, so every (projectId, deliveryId) pair is too.
--
-- Rollback (documentation; fails once two projects share a delivery id):
--   DROP INDEX "drift_events_projectId_deliveryId_key";
--   CREATE UNIQUE INDEX "drift_events_deliveryId_key" ON "drift_events"("deliveryId");

-- DropIndex
DROP INDEX "drift_events_deliveryId_key";

-- CreateIndex
CREATE UNIQUE INDEX "drift_events_projectId_deliveryId_key" ON "drift_events"("projectId", "deliveryId");
