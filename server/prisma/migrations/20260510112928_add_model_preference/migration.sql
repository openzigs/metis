-- CreateTable
CREATE TABLE "model_preferences" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "defaultModel" TEXT,
    "taskTypeOverrides" TEXT NOT NULL DEFAULT '{}',
    "budgetDowngradeThreshold" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "model_preferences_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "model_preferences_projectId_key" ON "model_preferences"("projectId");

-- CreateIndex
CREATE INDEX "model_preferences_projectId_idx" ON "model_preferences"("projectId");
