-- AlterTable
ALTER TABLE "ai_token_usages" ADD COLUMN "agentStep" TEXT;
ALTER TABLE "ai_token_usages" ADD COLUMN "estimatedCostUsd" REAL;
ALTER TABLE "ai_token_usages" ADD COLUMN "inferenceProfileArn" TEXT;
ALTER TABLE "ai_token_usages" ADD COLUMN "projectId" TEXT;

-- CreateTable
CREATE TABLE "inference_profiles" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "arn" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "costCenter" TEXT,
    "environment" TEXT,
    "tags" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "inference_profiles_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "token_budgets" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT,
    "userId" TEXT,
    "dailyTokenLimit" INTEGER,
    "monthlyTokenLimit" INTEGER,
    "downgradeModel" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "token_budgets_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "inference_profiles_projectId_key" ON "inference_profiles"("projectId");

-- CreateIndex
CREATE INDEX "inference_profiles_projectId_idx" ON "inference_profiles"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "token_budgets_projectId_key" ON "token_budgets"("projectId");

-- CreateIndex
CREATE INDEX "token_budgets_projectId_idx" ON "token_budgets"("projectId");

-- CreateIndex
CREATE INDEX "token_budgets_userId_idx" ON "token_budgets"("userId");

-- CreateIndex
CREATE INDEX "ai_token_usages_projectId_ts_idx" ON "ai_token_usages"("projectId", "ts");
