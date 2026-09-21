-- CreateTable
CREATE TABLE "suggested_connectors" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "driverType" TEXT NOT NULL,
    "host" TEXT,
    "port" INTEGER,
    "database" TEXT,
    "sourceFile" TEXT NOT NULL,
    "lineNumber" INTEGER NOT NULL,
    "confidence" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "suggested_connectors_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "suggested_connectors_projectId_status_idx" ON "suggested_connectors"("projectId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "suggested_connectors_projectId_driverType_host_port_database_key" ON "suggested_connectors"("projectId", "driverType", "host", "port", "database");
