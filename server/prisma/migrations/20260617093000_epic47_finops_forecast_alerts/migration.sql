-- Epic #47 — FinOps: forecasting (#48), alert engine (#49), alert channels (#50).
-- Adds the workspace monthly budget column plus the CostForecast, AlertRule,
-- AlertEvent, and AlertChannel models.

-- AlterTable: workspace monthly spend budget (cents).
ALTER TABLE "workspaces" ADD COLUMN "monthlyBudgetCents" INTEGER;

-- CreateTable
CREATE TABLE "cost_forecasts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT,
    "scope" TEXT NOT NULL,
    "monthToDateCents" INTEGER NOT NULL DEFAULT 0,
    "projectedMonthEndCents" INTEGER NOT NULL DEFAULT 0,
    "dailyRunRateCents" INTEGER NOT NULL DEFAULT 0,
    "slopeCentsPerDay" REAL NOT NULL DEFAULT 0,
    "ewmaCents" REAL NOT NULL DEFAULT 0,
    "sampleDays" INTEGER NOT NULL DEFAULT 0,
    "backtestMape" REAL,
    "computedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "cost_forecasts_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "alert_rules" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "thresholdPct" INTEGER NOT NULL,
    "basis" TEXT NOT NULL DEFAULT 'projected',
    "cooldownSec" INTEGER NOT NULL DEFAULT 3600,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastFiredAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "alert_rules_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "alert_events" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "spendCents" INTEGER NOT NULL,
    "budgetCents" INTEGER NOT NULL,
    "ratio" REAL NOT NULL,
    "basis" TEXT NOT NULL,
    "deliveries" TEXT NOT NULL DEFAULT '[]',
    "firedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "alert_events_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "alert_events_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "alert_rules" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "alert_channels" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "secret" TEXT,
    "config" TEXT NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "alert_channels_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "cost_forecasts_workspaceId_scope_computedAt_idx" ON "cost_forecasts"("workspaceId", "scope", "computedAt");

-- CreateIndex
CREATE INDEX "cost_forecasts_projectId_computedAt_idx" ON "cost_forecasts"("projectId", "computedAt");

-- CreateIndex
CREATE INDEX "alert_rules_workspaceId_enabled_idx" ON "alert_rules"("workspaceId", "enabled");

-- CreateIndex
CREATE INDEX "alert_events_workspaceId_firedAt_idx" ON "alert_events"("workspaceId", "firedAt");

-- CreateIndex
CREATE INDEX "alert_events_ruleId_firedAt_idx" ON "alert_events"("ruleId", "firedAt");

-- CreateIndex
CREATE INDEX "alert_channels_workspaceId_enabled_idx" ON "alert_channels"("workspaceId", "enabled");
