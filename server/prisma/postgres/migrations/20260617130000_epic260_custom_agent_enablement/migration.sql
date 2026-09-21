-- Epic #260 (#79): dedicated CustomAgent <-> project enablement join.
-- A workspace-shared agent (custom_agents.projectId = NULL) or a built-in is
-- opted IN to a specific project by a row here. Distinct from the Library
-- Agent allowlist (project_agent_allowlists) which gates a different model.

-- CreateTable
CREATE TABLE IF NOT EXISTS "custom_agent_enablements" (
    "id" TEXT NOT NULL,
    "customAgentId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "enabledById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "custom_agent_enablements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "custom_agent_enablements_projectId_enabled_idx" ON "custom_agent_enablements"("projectId", "enabled");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "custom_agent_enablements_customAgentId_idx" ON "custom_agent_enablements"("customAgentId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "custom_agent_enablements_customAgentId_projectId_key" ON "custom_agent_enablements"("customAgentId", "projectId");

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'custom_agent_enablements_customAgentId_fkey') THEN
    EXECUTE 'ALTER TABLE "custom_agent_enablements" ADD CONSTRAINT "custom_agent_enablements_customAgentId_fkey"
    FOREIGN KEY ("customAgentId") REFERENCES "custom_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END
$idem$;

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'custom_agent_enablements_projectId_fkey') THEN
    EXECUTE 'ALTER TABLE "custom_agent_enablements" ADD CONSTRAINT "custom_agent_enablements_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END
$idem$;
