-- Epic #260 (#79): dedicated CustomAgent <-> project enablement join.
-- A workspace-shared agent (custom_agents.projectId = NULL) or a built-in is
-- opted IN to a specific project by a row here. Distinct from the Library
-- Agent allowlist (project_agent_allowlists) which gates a different model.

-- CreateTable
CREATE TABLE "custom_agent_enablements" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "customAgentId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "enabledById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "custom_agent_enablements_customAgentId_fkey" FOREIGN KEY ("customAgentId") REFERENCES "custom_agents" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "custom_agent_enablements_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "custom_agent_enablements_projectId_enabled_idx" ON "custom_agent_enablements"("projectId", "enabled");

-- CreateIndex
CREATE INDEX "custom_agent_enablements_customAgentId_idx" ON "custom_agent_enablements"("customAgentId");

-- CreateIndex
CREATE UNIQUE INDEX "custom_agent_enablements_customAgentId_projectId_key" ON "custom_agent_enablements"("customAgentId", "projectId");
