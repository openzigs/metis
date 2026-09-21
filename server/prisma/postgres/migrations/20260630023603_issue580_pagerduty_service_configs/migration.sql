-- Issue #580 (epic #63) — per-workspace PagerDuty Events API v2 service configs.
-- Postgres mirror of the SQLite migration.
--
-- Adds the `pagerduty_service_configs` table. ADDITIVE — no existing table is
-- altered. All structural DDL is idempotent (`IF NOT EXISTS`; FKs wrapped in
-- pg_constraint existence DO-blocks) so the full migration history replays cleanly
-- over the cumulative `00000000000000_init` baseline on a fresh Postgres (#556 guard).
--
-- SECRET HANDLING: the PagerDuty routing key is NOT a column. Only the
-- `${vault:label}` reference is stored in `routingKeyRef`.

-- CreateTable
CREATE TABLE IF NOT EXISTS "pagerduty_service_configs" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "serviceKey" TEXT NOT NULL,
    "routingKeyRef" TEXT NOT NULL,
    "label" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pagerduty_service_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "pagerduty_service_configs_workspaceId_idx" ON "pagerduty_service_configs"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "pagerduty_service_configs_workspaceId_serviceKey_key" ON "pagerduty_service_configs"("workspaceId", "serviceKey");

-- AddForeignKey (guarded — bare ADD CONSTRAINT has no IF NOT EXISTS in Postgres)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pagerduty_service_configs_workspaceId_fkey') THEN
    ALTER TABLE "pagerduty_service_configs" ADD CONSTRAINT "pagerduty_service_configs_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pagerduty_service_configs_createdById_fkey') THEN
    ALTER TABLE "pagerduty_service_configs" ADD CONSTRAINT "pagerduty_service_configs_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
