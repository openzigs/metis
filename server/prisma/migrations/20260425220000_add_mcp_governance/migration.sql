-- Epic #162 — MCP platform governance, integrity, registry cache, approvals.

-- AlterTable: extend mcp_servers with governance + integrity columns.
ALTER TABLE "mcp_servers" ADD COLUMN "toolSchemaSnapshot" TEXT;
ALTER TABLE "mcp_servers" ADD COLUMN "toolSchemaApprovedAt" DATETIME;
ALTER TABLE "mcp_servers" ADD COLUMN "toolAllowlist" TEXT;
ALTER TABLE "mcp_servers" ADD COLUMN "requireApproval" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable: per-tool, per-session approval audit log.
CREATE TABLE "mcp_tool_approvals" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "args" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" DATETIME,
    "decidedBy" TEXT,
    CONSTRAINT "mcp_tool_approvals_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "mcp_servers" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "mcp_tool_approvals_decidedBy_fkey" FOREIGN KEY ("decidedBy") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "mcp_tool_approvals_sessionId_idx" ON "mcp_tool_approvals"("sessionId");
CREATE INDEX "mcp_tool_approvals_status_idx" ON "mcp_tool_approvals"("status");

-- CreateTable: persistent 24h cache of the public MCP registry payload.
CREATE TABLE "mcp_registry_cache" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'singleton',
    "fetchedAt" DATETIME NOT NULL,
    "payload" TEXT NOT NULL
);
