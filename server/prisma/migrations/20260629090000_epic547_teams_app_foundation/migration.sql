-- Epic #547 (Phase 0, #548) — Microsoft Teams app foundation.
--
-- Adds the `teams_app_installations` + `teams_conversation_references` tables:
-- the SHARED Teams-app plumbing reused by the collaboration bridge (#549–#554)
-- and the pre-existing ChatOps/notification epics (#63/#67).
--
-- The migration is ADDITIVE — no existing table is altered — so it is
-- non-destructive and trivially reversible
-- (DROP TABLE teams_conversation_references; DROP TABLE teams_app_installations).
--
-- SECRET HANDLING: the bot's Microsoft App Password is NOT a column here. Only a
-- `${vault:label}` reference is persisted in `appPasswordRef`; the plaintext
-- secret lives encrypted in the `secrets` vault (AES-256-GCM).

-- CreateTable
CREATE TABLE "teams_app_installations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "appPasswordRef" TEXT NOT NULL,
    "tenantId" TEXT,
    "appType" TEXT NOT NULL DEFAULT 'MultiTenant',
    "status" TEXT NOT NULL DEFAULT 'active',
    "label" TEXT,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "teams_app_installations_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "teams_app_installations_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "teams_conversation_references" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "installationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "serviceUrl" TEXT NOT NULL,
    "tenantId" TEXT,
    "channelId" TEXT NOT NULL,
    "aadObjectId" TEXT,
    "userId" TEXT,
    "reference" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "teams_conversation_references_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "teams_app_installations" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "teams_app_installations_workspaceId_idx" ON "teams_app_installations"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "teams_app_installations_workspaceId_appId_key" ON "teams_app_installations"("workspaceId", "appId");

-- CreateIndex
CREATE INDEX "teams_conversation_references_installationId_idx" ON "teams_conversation_references"("installationId");

-- CreateIndex
CREATE INDEX "teams_conversation_references_workspaceId_idx" ON "teams_conversation_references"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "teams_conversation_references_workspaceId_conversationId_key" ON "teams_conversation_references"("workspaceId", "conversationId");
