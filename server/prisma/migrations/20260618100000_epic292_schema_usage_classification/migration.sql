-- CreateTable
CREATE TABLE "schema_usage_classifications" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "tableName" TEXT NOT NULL,
    "columnName" TEXT,
    "columnType" TEXT,
    "usageClass" TEXT NOT NULL,
    "uncertainReason" TEXT,
    "evidence" TEXT NOT NULL DEFAULT '[]',
    "overriddenClass" TEXT,
    "computedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "schema_usage_classifications_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "schema_usage_classifications_projectId_usageClass_idx" ON "schema_usage_classifications"("projectId", "usageClass");

-- CreateIndex
CREATE INDEX "schema_usage_classifications_projectId_tableName_idx" ON "schema_usage_classifications"("projectId", "tableName");
