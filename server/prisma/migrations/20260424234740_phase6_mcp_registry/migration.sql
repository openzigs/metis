-- CreateTable
CREATE TABLE "project_mcp_allowlists" (
    "projectId" TEXT NOT NULL,
    "mcpServerId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("projectId", "mcpServerId"),
    CONSTRAINT "project_mcp_allowlists_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "project_mcp_allowlists_mcpServerId_fkey" FOREIGN KEY ("mcpServerId") REFERENCES "mcp_servers" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_mcp_servers" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scope" TEXT NOT NULL DEFAULT 'global',
    "projectId" TEXT,
    "label" TEXT NOT NULL,
    "transport" TEXT NOT NULL,
    "command" TEXT,
    "args" TEXT,
    "url" TEXT,
    "headers" TEXT,
    "envJson" TEXT,
    "envSecretId" TEXT,
    "envSecretRefs" TEXT,
    "trustLevel" TEXT NOT NULL DEFAULT 'untrusted',
    "defaultToolRisk" TEXT NOT NULL DEFAULT 'medium',
    "version" TEXT,
    "sha256" TEXT,
    "capabilities" TEXT,
    "status" TEXT NOT NULL DEFAULT 'idle',
    "lastHealthCheckAt" DATETIME,
    "latencyMs" INTEGER,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "healthCheckIntervalSec" INTEGER NOT NULL DEFAULT 60,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "mcp_servers_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "mcp_servers_envSecretId_fkey" FOREIGN KEY ("envSecretId") REFERENCES "secrets" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "mcp_servers_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_mcp_servers" ("capabilities", "command", "createdAt", "createdById", "deletedAt", "enabled", "envSecretId", "id", "label", "projectId", "scope", "transport", "updatedAt", "url") SELECT "capabilities", "command", "createdAt", "createdById", "deletedAt", "enabled", "envSecretId", "id", "label", "projectId", "scope", "transport", "updatedAt", "url" FROM "mcp_servers";
DROP TABLE "mcp_servers";
ALTER TABLE "new_mcp_servers" RENAME TO "mcp_servers";
CREATE INDEX "mcp_servers_scope_idx" ON "mcp_servers"("scope");
CREATE INDEX "mcp_servers_status_idx" ON "mcp_servers"("status");
CREATE UNIQUE INDEX "mcp_servers_scope_projectId_label_key" ON "mcp_servers"("scope", "projectId", "label");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "project_mcp_allowlists_mcpServerId_idx" ON "project_mcp_allowlists"("mcpServerId");
