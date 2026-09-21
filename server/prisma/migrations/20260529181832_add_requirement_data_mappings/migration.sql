-- CreateTable
CREATE TABLE "requirement_data_mappings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "requirementId" TEXT NOT NULL,
    "dbConnectorId" TEXT NOT NULL,
    "schemaName" TEXT,
    "tableName" TEXT NOT NULL,
    "columnName" TEXT,
    "confidence" REAL NOT NULL DEFAULT 0.7,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "requirement_data_mappings_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "requirements" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "requirement_data_mappings_dbConnectorId_fkey" FOREIGN KEY ("dbConnectorId") REFERENCES "database_connections" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "requirement_data_mappings_requirementId_idx" ON "requirement_data_mappings"("requirementId");

-- CreateIndex
CREATE INDEX "requirement_data_mappings_dbConnectorId_idx" ON "requirement_data_mappings"("dbConnectorId");

-- CreateIndex
CREATE UNIQUE INDEX "requirement_data_mappings_requirementId_dbConnectorId_schemaName_tableName_columnName_key" ON "requirement_data_mappings"("requirementId", "dbConnectorId", "schemaName", "tableName", "columnName");
