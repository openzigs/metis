-- Epic #47 — FinOps: forecasting (#48), alert engine (#49), alert channels (#50).
-- Postgres twin of the SQLite migration of the same name (schema-parity).
-- Adds the workspace monthly budget column plus the CostForecast, AlertRule,
-- AlertEvent, and AlertChannel models.

-- AlterTable: workspace monthly spend budget (cents).
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "monthlyBudgetCents" INTEGER;

-- CreateTable
CREATE TABLE IF NOT EXISTS "cost_forecasts" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT,
    "scope" TEXT NOT NULL,
    "monthToDateCents" INTEGER NOT NULL DEFAULT 0,
    "projectedMonthEndCents" INTEGER NOT NULL DEFAULT 0,
    "dailyRunRateCents" INTEGER NOT NULL DEFAULT 0,
    "slopeCentsPerDay" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "ewmaCents" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sampleDays" INTEGER NOT NULL DEFAULT 0,
    "backtestMape" DOUBLE PRECISION,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cost_forecasts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "alert_rules" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "thresholdPct" INTEGER NOT NULL,
    "basis" TEXT NOT NULL DEFAULT 'projected',
    "cooldownSec" INTEGER NOT NULL DEFAULT 3600,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastFiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "alert_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "alert_events" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "spendCents" INTEGER NOT NULL,
    "budgetCents" INTEGER NOT NULL,
    "ratio" DOUBLE PRECISION NOT NULL,
    "basis" TEXT NOT NULL,
    "deliveries" TEXT NOT NULL DEFAULT '[]',
    "firedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alert_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "alert_channels" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "secret" TEXT,
    "config" TEXT NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "alert_channels_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "cost_forecasts_workspaceId_scope_computedAt_idx" ON "cost_forecasts"("workspaceId", "scope", "computedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "cost_forecasts_projectId_computedAt_idx" ON "cost_forecasts"("projectId", "computedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "alert_rules_workspaceId_enabled_idx" ON "alert_rules"("workspaceId", "enabled");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "alert_events_workspaceId_firedAt_idx" ON "alert_events"("workspaceId", "firedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "alert_events_ruleId_firedAt_idx" ON "alert_events"("ruleId", "firedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "alert_channels_workspaceId_enabled_idx" ON "alert_channels"("workspaceId", "enabled");

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cost_forecasts_workspaceId_fkey') THEN
    EXECUTE 'ALTER TABLE "cost_forecasts" ADD CONSTRAINT "cost_forecasts_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END
$idem$;

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'alert_rules_workspaceId_fkey') THEN
    EXECUTE 'ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END
$idem$;

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'alert_events_workspaceId_fkey') THEN
    EXECUTE 'ALTER TABLE "alert_events" ADD CONSTRAINT "alert_events_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END
$idem$;

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'alert_events_ruleId_fkey') THEN
    EXECUTE 'ALTER TABLE "alert_events" ADD CONSTRAINT "alert_events_ruleId_fkey"
    FOREIGN KEY ("ruleId") REFERENCES "alert_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END
$idem$;

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'alert_channels_workspaceId_fkey') THEN
    EXECUTE 'ALTER TABLE "alert_channels" ADD CONSTRAINT "alert_channels_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END
$idem$;
