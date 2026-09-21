-- CreateTable
CREATE TABLE "schema_usage_overrides" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "tableName" TEXT NOT NULL,
    "columnName" TEXT,
    "usageClass" TEXT NOT NULL,
    "access" TEXT NOT NULL DEFAULT 'reads',
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "schema_usage_overrides_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "schema_usage_overrides_projectId_idx" ON "schema_usage_overrides"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "schema_usage_overrides_projectId_tableName_columnName_access_key" ON "schema_usage_overrides"("projectId", "tableName", "columnName", "access");

