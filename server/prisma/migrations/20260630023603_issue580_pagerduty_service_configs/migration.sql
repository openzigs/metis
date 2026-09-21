-- Issue #580 (epic #63) — per-workspace PagerDuty Events API v2 service configs.
--
-- Adds the `pagerduty_service_configs` table: a per-(workspace, serviceKey)
-- mapping to a PagerDuty routing key for sev-1 critical-event alerting. ADDITIVE —
-- no existing table is altered — so it is non-destructive and trivially reversible
-- (DROP TABLE pagerduty_service_configs).
--
-- SECRET HANDLING: the PagerDuty routing key is NOT a column. Only the
-- `${vault:label}` reference is stored in `routingKeyRef`; the plaintext key is
-- encrypted in the hardened vault (AES-256-GCM), mirroring #548 appPasswordRef.

-- CreateTable
CREATE TABLE "pagerduty_service_configs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "serviceKey" TEXT NOT NULL,
    "routingKeyRef" TEXT NOT NULL,
    "label" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "pagerduty_service_configs_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "pagerduty_service_configs_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "pagerduty_service_configs_workspaceId_idx" ON "pagerduty_service_configs"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "pagerduty_service_configs_workspaceId_serviceKey_key" ON "pagerduty_service_configs"("workspaceId", "serviceKey");
