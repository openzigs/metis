-- Epic #856 Phase 3 — Issue #871 — TestManagementConnection model.
-- External test management tool connections (Xray / Zephyr / TestRail).
-- Secrets are stored as `${vault:label}` refs inside the JSON columns; raw
-- credentials are never persisted on this row.

CREATE TABLE "test_management_connections" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "authConfigJson" TEXT NOT NULL DEFAULT '{}',
    "proxyConfigJson" TEXT,
    "tlsConfigJson" TEXT,
    "status" TEXT NOT NULL DEFAULT 'untested',
    "errorMessage" TEXT,
    "lastTestedAt" DATETIME,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "test_management_connections_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "test_management_connections_projectId_idx" ON "test_management_connections"("projectId");

CREATE INDEX "test_management_connections_projectId_kind_idx" ON "test_management_connections"("projectId", "kind");

CREATE UNIQUE INDEX "test_management_connections_projectId_label_key" ON "test_management_connections"("projectId", "label");
