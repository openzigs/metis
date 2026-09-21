-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "workspaces" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "logoUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_members" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workspace_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_invites" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "token" TEXT NOT NULL,
    "invitedById" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_usage_daily" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "tokensUsed" INTEGER NOT NULL DEFAULT 0,
    "costCents" INTEGER NOT NULL DEFAULT 0,
    "sessions" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_usage_daily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "lastLoginAt" TIMESTAMP(3),
    "passwordHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "userId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("userId","roleId")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "roleId" TEXT NOT NULL,
    "permissionId" TEXT NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("roleId","permissionId")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "argsHash" TEXT,
    "resultHash" TEXT,
    "metadata" TEXT,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "config_audit" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "oldValueRedacted" TEXT NOT NULL,
    "newValueRedacted" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'global',
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "config_audit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "runtime_config" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "valueType" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'global',
    "updatedById" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "runtime_config_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "secrets" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "ciphertext" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "salt" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "algorithm" TEXT NOT NULL DEFAULT 'aes-256-gcm',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "secrets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "aiProviderId" TEXT,
    "aiModel" TEXT,
    "monthlyTokenBudget" INTEGER,
    "safetyMode" TEXT NOT NULL DEFAULT 'standard',
    "autopilotEnabled" BOOLEAN NOT NULL DEFAULT false,
    "autopilotCostCeilingCents" INTEGER,
    "autoApproveTrustedSources" BOOLEAN NOT NULL DEFAULT false,
    "chronicleEnabled" BOOLEAN NOT NULL DEFAULT false,
    "chronicleTtlDays" INTEGER NOT NULL DEFAULT 28,
    "allowCredentialScan" BOOLEAN NOT NULL DEFAULT false,
    "redTeamLastRunAt" TIMESTAMP(3),
    "redTeamLastScore" DOUBLE PRECISION,
    "skillDirectories" TEXT NOT NULL DEFAULT '[]',
    "disabledSkills" TEXT NOT NULL DEFAULT '[]',
    "planModeRequired" BOOLEAN NOT NULL DEFAULT false,
    "specKitEnabled" BOOLEAN NOT NULL DEFAULT false,
    "autoReviewPrs" BOOLEAN NOT NULL DEFAULT false,
    "autoApproveSandbox" BOOLEAN NOT NULL DEFAULT false,
    "prReviewMaxDiffBytes" INTEGER,
    "prReviewSkipGlobs" TEXT,
    "prReviewMonthlyBudgetCents" INTEGER,
    "sandboxProvider" TEXT NOT NULL DEFAULT 'e2b',
    "sandboxTimeoutMs" INTEGER NOT NULL DEFAULT 60000,
    "sandboxEgressAllowlist" TEXT NOT NULL DEFAULT '[]',
    "createdById" TEXT NOT NULL,
    "workspaceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "publishDestination" TEXT NOT NULL DEFAULT 'github',
    "jiraProjectKey" TEXT,
    "jiraConnectionId" TEXT,
    "productId" TEXT,
    "contextCompactionThreshold" INTEGER,
    "githubProjectId" TEXT,
    "githubProjectFieldMappings" TEXT,
    "overviewMarkdown" TEXT,
    "overviewGeneratedAt" TIMESTAMP(3),
    "databaseAwareAnalysis" TEXT NOT NULL DEFAULT 'auto',
    "sqlLineage" TEXT NOT NULL DEFAULT 'auto',

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "token_usages" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "sessionId" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "costCents" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "token_usages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_preferences" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "defaultModel" TEXT,
    "taskTypeOverrides" TEXT NOT NULL DEFAULT '{}',
    "budgetDowngradeThreshold" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "model_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "safety_events" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "sessionId" TEXT,
    "direction" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "findings" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "safety_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storagePath" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "indexState" TEXT NOT NULL DEFAULT 'pending',
    "autoApproveTrusted" BOOLEAN NOT NULL DEFAULT false,
    "aclSubjects" TEXT NOT NULL DEFAULT '[]',
    "isSpec" BOOLEAN NOT NULL DEFAULT false,
    "errorMessage" TEXT,
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "uploadedById" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_chunks" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "md5" TEXT NOT NULL,
    "embeddingModel" TEXT NOT NULL DEFAULT 'metis-offline-hash-v1',
    "chunkerIdentity" TEXT,
    "vectorRef" TEXT,
    "metadata" TEXT,
    "aclSubjects" TEXT NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quarantine_chunks" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "ord" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "embedding" TEXT NOT NULL,
    "metadata" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quarantine_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chronicle_entries" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "sourceSessionId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chronicle_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repo_connections" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'github',
    "ownerOrOrg" TEXT NOT NULL,
    "repoName" TEXT NOT NULL,
    "defaultBranch" TEXT NOT NULL DEFAULT 'main',
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "apiBaseUrl" TEXT,
    "secretId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "errorMessage" TEXT,
    "lastTestedAt" TIMESTAMP(3),
    "lastIngestAt" TIMESTAMP(3),
    "lastCommitSha" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "repo_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "database_connections" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "driver" TEXT NOT NULL,
    "host" TEXT,
    "port" INTEGER,
    "databaseName" TEXT,
    "username" TEXT,
    "secretId" TEXT,
    "options" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "errorMessage" TEXT,
    "lastTestedAt" TIMESTAMP(3),
    "lastIngestAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "database_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suggested_connectors" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "driverType" TEXT NOT NULL,
    "host" TEXT,
    "port" INTEGER,
    "database" TEXT,
    "sourceFile" TEXT NOT NULL,
    "lineNumber" INTEGER NOT NULL,
    "confidence" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "username" TEXT,
    "passwordVaultRef" TEXT,
    "devCredsDetected" BOOLEAN NOT NULL DEFAULT false,
    "credentialSourceFile" TEXT,
    "acceptedConnectorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "suggested_connectors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analyses" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "startedById" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "metadata" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "analyses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
-- Epic #201 (#210) — durable clarification dialog state.
CREATE TABLE "clarification_dialog_states" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clarification_dialog_states_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "clarification_dialog_states_analysisId_key" ON "clarification_dialog_states"("analysisId");

-- AddForeignKey
ALTER TABLE "clarification_dialog_states" ADD CONSTRAINT "clarification_dialog_states_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "analyses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
-- Epic #203 (#221) — first-class cross-document conflict/completeness findings.
CREATE TABLE "cross_doc_findings" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'medium',
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "evidenceIds" TEXT NOT NULL DEFAULT '[]',
    "scope" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cross_doc_findings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cross_doc_findings_analysisId_idx" ON "cross_doc_findings"("analysisId");

-- CreateIndex
CREATE INDEX "cross_doc_findings_kind_idx" ON "cross_doc_findings"("kind");

-- AddForeignKey
ALTER TABLE "cross_doc_findings" ADD CONSTRAINT "cross_doc_findings_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "analyses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "agent_results" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "agentKey" TEXT NOT NULL,
    "connectorId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "output" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "findings" (
    "id" TEXT NOT NULL,
    -- #1330 (ADR 0011): nullable — a Finding materialised from an approved
    -- ScanFinding has no AgentResult; its provenance is "scanFindingId".
    "agentResultId" TEXT,
    "category" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'info',
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "evidence" TEXT,
    "derivation" TEXT NOT NULL DEFAULT 'inferred',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
    "symbolId" TEXT,
    "scanFindingId" TEXT,
    "verificationStatus" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "findings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "requirements" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'feature',
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'medium',
    "labels" TEXT NOT NULL DEFAULT '[]',
    "reviewStatus" TEXT,
    "coverage" TEXT,
    "verdict" TEXT,
    "acceptanceCriteria" TEXT NOT NULL DEFAULT '[]',
    "storyPoints" INTEGER,
    "parentId" TEXT,
    "implementedAt" TIMESTAMP(3),
    "implementedByPr" INTEGER,
    "implementedBySha" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "requirements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "requirement_implementations" (
    "id" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "prNumber" INTEGER NOT NULL,
    "prUrl" TEXT NOT NULL,
    "commitSha" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "startLine" INTEGER,
    "endLine" INTEGER,
    "mergedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "requirement_implementations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "requirement_data_mappings" (
    "id" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "dbConnectorId" TEXT NOT NULL,
    "schemaName" TEXT,
    "tableName" TEXT NOT NULL,
    "columnName" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "requirement_data_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "issue_drafts" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "requirementId" TEXT,
    "parentDraftId" TEXT,
    "draftType" TEXT NOT NULL DEFAULT 'feature',
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "labels" TEXT NOT NULL DEFAULT '[]',
    "assignees" TEXT NOT NULL DEFAULT '[]',
    "storyPoints" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "dedupHash" TEXT,
    "metadata" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "issue_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "issue_templates" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'universal',
    "templateType" TEXT NOT NULL DEFAULT 'feature',
    "schema" TEXT NOT NULL,
    "defaultValues" TEXT NOT NULL DEFAULT '{}',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "issue_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publish_batches" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "targetOwner" TEXT NOT NULL,
    "targetRepo" TEXT NOT NULL,
    "targetBaseUrl" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'github',
    "dryRun" BOOLEAN NOT NULL DEFAULT false,
    "totalDrafts" INTEGER NOT NULL DEFAULT 0,
    "publishedCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "dedupSkipped" INTEGER NOT NULL DEFAULT 0,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "archivedAt" TIMESTAMP(3),
    "archiveReason" TEXT,
    "archivedById" TEXT,
    "dryRunPlan" TEXT,
    "startedById" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "metadata" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "publish_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "published_issues" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "issueNumber" INTEGER NOT NULL,
    "issueId" TEXT NOT NULL,
    "htmlUrl" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'created',
    "destination" TEXT NOT NULL DEFAULT 'github',
    "parentIssueNumber" INTEGER,
    "dedupHash" TEXT,
    "bodyHash" TEXT,
    "errorMessage" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "published_issues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "change_analyses" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "baseAnalysisId" TEXT NOT NULL,
    "headAnalysisId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "summary" TEXT,
    "totalChanges" INTEGER NOT NULL DEFAULT 0,
    "additions" INTEGER NOT NULL DEFAULT 0,
    "removals" INTEGER NOT NULL DEFAULT 0,
    "modifications" INTEGER NOT NULL DEFAULT 0,
    "startedById" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "change_analyses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "requirement_changes" (
    "id" TEXT NOT NULL,
    "changeAnalysisId" TEXT NOT NULL,
    "changeType" TEXT NOT NULL DEFAULT 'modified',
    "severity" TEXT NOT NULL DEFAULT 'medium',
    "impactScore" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "requirementId" TEXT,
    "previousRequirementId" TEXT,
    "title" TEXT NOT NULL,
    "previousTitle" TEXT,
    "body" TEXT NOT NULL,
    "previousBody" TEXT,
    "diffSummary" TEXT,
    "reviewStatus" TEXT NOT NULL DEFAULT 'pending',
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "requirement_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_servers" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'global',
    "projectId" TEXT,
    "userId" TEXT,
    "label" TEXT NOT NULL,
    "transport" TEXT NOT NULL,
    "runtime" TEXT NOT NULL DEFAULT 'native',
    "egressAllowlist" TEXT,
    "k8sMemoryLimit" TEXT,
    "k8sCpuLimit" TEXT,
    "coldStart" BOOLEAN NOT NULL DEFAULT false,
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
    "toolSchemaSnapshot" TEXT,
    "toolSchemaApprovedAt" TIMESTAMP(3),
    "toolAllowlist" TEXT,
    "requireApproval" BOOLEAN NOT NULL DEFAULT false,
    "capabilities" TEXT,
    "status" TEXT NOT NULL DEFAULT 'idle',
    "lastHealthCheckAt" TIMESTAMP(3),
    "lastToolInvocationAt" TIMESTAMP(3),
    "latencyMs" INTEGER,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "healthCheckIntervalSec" INTEGER NOT NULL DEFAULT 60,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "mcp_servers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_mcp_allowlists" (
    "projectId" TEXT NOT NULL,
    "mcpServerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_mcp_allowlists_pkey" PRIMARY KEY ("projectId","mcpServerId")
);

-- CreateTable
CREATE TABLE "mcp_tool_approvals" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "args" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "decidedBy" TEXT,

    CONSTRAINT "mcp_tool_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_registry_cache" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "payload" TEXT NOT NULL,

    CONSTRAINT "mcp_registry_cache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_registry_entries" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT DEFAULT '',
    "publisher" TEXT,
    "version" TEXT,
    "downloads" INTEGER,
    "stars" INTEGER,
    "lastUpdated" TIMESTAMP(3),
    "sha256" TEXT,
    "manifest" TEXT NOT NULL DEFAULT '{}',
    "metadata" TEXT NOT NULL DEFAULT '{}',
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mcp_registry_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spec_kit_artifacts" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "spec_kit_artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spec_kit_features" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "branchName" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "spec_kit_features_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spec_kit_feature_artifacts" (
    "id" TEXT NOT NULL,
    "featureId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "spec_kit_feature_artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spec_kit_constitutions" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "version" TEXT NOT NULL DEFAULT '0.0.0',
    "ratifiedAt" TIMESTAMP(3),
    "lastAmendedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "spec_kit_constitutions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spec_kit_configs" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "checklistDomains" TEXT NOT NULL DEFAULT '[]',
    "tasksToIssuesParentEpic" INTEGER,
    "tasksToIssuesRepo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "spec_kit_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spec_kit_task_exports" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "featureSlug" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "issueNumber" INTEGER NOT NULL,
    "repoOwner" TEXT NOT NULL,
    "repoName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "spec_kit_task_exports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skills" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "version" TEXT NOT NULL DEFAULT '0.1.0',
    "instructions" TEXT NOT NULL DEFAULT '',
    "tools" TEXT NOT NULL DEFAULT '[]',
    "resources" TEXT NOT NULL DEFAULT '[]',
    "tags" TEXT NOT NULL DEFAULT '[]',
    "manifest" TEXT NOT NULL DEFAULT '{}',
    "contentSha256" TEXT,
    "source" TEXT NOT NULL DEFAULT 'inline',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "skills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skill_versions" (
    "id" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "manifest" TEXT NOT NULL DEFAULT '{}',
    "instructions" TEXT NOT NULL DEFAULT '',
    "contentSha256" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "skill_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agents" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "displayName" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL DEFAULT '',
    "model" TEXT NOT NULL DEFAULT '',
    "systemPrompt" TEXT NOT NULL DEFAULT '',
    "tools" TEXT NOT NULL DEFAULT '[]',
    "tags" TEXT NOT NULL DEFAULT '[]',
    "handoffs" TEXT NOT NULL DEFAULT '[]',
    "manifest" TEXT NOT NULL DEFAULT '{}',
    "contentSha256" TEXT,
    "source" TEXT NOT NULL DEFAULT 'inline',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "version" TEXT NOT NULL DEFAULT '0.1.0',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_versions" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "manifest" TEXT NOT NULL DEFAULT '{}',
    "systemPrompt" TEXT NOT NULL DEFAULT '',
    "contentSha256" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_skills" (
    "agentId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,

    CONSTRAINT "agent_skills_pkey" PRIMARY KEY ("agentId","skillId")
);

-- CreateTable
CREATE TABLE "project_skill_allowlists" (
    "projectId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "addedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_skill_allowlists_pkey" PRIMARY KEY ("projectId","skillId")
);

-- CreateTable
CREATE TABLE "project_agent_allowlists" (
    "projectId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "addedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_agent_allowlists_pkey" PRIMARY KEY ("projectId","agentId")
);

-- CreateTable
CREATE TABLE "scheduled_jobs" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cron" TEXT NOT NULL,
    "taskType" TEXT NOT NULL DEFAULT 'http-webhook',
    "payload" TEXT NOT NULL DEFAULT '{}',
    "projectId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "lastFiredAt" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3),
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "scheduled_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" TEXT NOT NULL,
    "scheduledJobId" TEXT,
    "projectId" TEXT,
    "type" TEXT NOT NULL,
    "trigger" TEXT NOT NULL DEFAULT 'manual',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "priority" INTEGER NOT NULL DEFAULT 5,
    "payload" TEXT NOT NULL DEFAULT '{}',
    "result" TEXT,
    "errorMessage" TEXT,
    "progress" INTEGER,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "scheduledFor" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT,
    "title" TEXT NOT NULL DEFAULT 'New Chat',
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "policy" TEXT NOT NULL DEFAULT '{"low":"auto","medium":"prompt-once","high":"always-prompt"}',
    "status" TEXT NOT NULL DEFAULT 'active',
    "providerSecretRef" TEXT,
    "copilotHome" TEXT,
    "agentId" TEXT,
    "agentSnapshot" TEXT,
    "loadedSkillIds" TEXT NOT NULL DEFAULT '[]',
    "currentModel" TEXT,
    "currentReasoningEffort" TEXT,
    "planModeActive" BOOLEAN NOT NULL DEFAULT false,
    "snapshot" TEXT,
    "snapshotUpdatedAt" TIMESTAMP(3),
    "lastCompactedAt" TIMESTAMP(3),
    "compactionCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "ai_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_token_usages" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
    "promptHash" TEXT,
    "category_breakdown" TEXT,
    "dayBucket" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "projectId" TEXT,
    "inferenceProfileArn" TEXT,
    "estimatedCostUsd" DOUBLE PRECISION,
    "agentStep" TEXT,

    CONSTRAINT "ai_token_usages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_tool_approvals" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "risk" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "reason" TEXT,
    "argsHash" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_tool_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_runs" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "projectId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'chat',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "latencyMs" INTEGER,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "costCents" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'running',

    CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_run_steps" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "ord" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "spanId" TEXT,
    "traceId" TEXT,
    "latencyMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_run_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "known_agent_definitions" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'agents-md',
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "systemPrompt" TEXT NOT NULL DEFAULT '',
    "tools" TEXT NOT NULL DEFAULT '[]',
    "model" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "known_agent_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_agents" (
    "id" TEXT NOT NULL,
    "projectId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "systemPrompt" TEXT NOT NULL DEFAULT '',
    "tools" TEXT NOT NULL DEFAULT '[]',
    "model" TEXT,
    "reasoningEffort" TEXT,
    "isBuiltIn" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "custom_agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_agent_enablements" (
    "id" TEXT NOT NULL,
    "customAgentId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "enabledById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "custom_agent_enablements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hook_subscriptions" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "handlerKind" TEXT NOT NULL DEFAULT 'webhook',
    "config" TEXT NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hook_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_plans" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "planText" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "decidedAt" TIMESTAMP(3),
    "decidedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "session_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "background_runs" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "sessionId" TEXT,
    "kind" TEXT NOT NULL,
    "payload" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "runGroupId" TEXT,
    "heartbeatAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "error" TEXT,
    "result" TEXT,
    "score" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "background_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "triggers" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "config" TEXT NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastFiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "triggers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "run_groups" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "parentRunId" TEXT,
    "n" INTEGER NOT NULL DEFAULT 1,
    "strategy" TEXT NOT NULL DEFAULT 'best-of-n',
    "selectionMethod" TEXT NOT NULL DEFAULT 'highest-score',
    "winnerRunId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "run_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "run_messages" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "ord" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),

    CONSTRAINT "run_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "scopes" TEXT NOT NULL DEFAULT '[]',
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bench_runs" (
    "id" TEXT NOT NULL,
    "benchmark" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalTasks" INTEGER NOT NULL DEFAULT 0,
    "passedTasks" INTEGER NOT NULL DEFAULT 0,
    "meanTokens" INTEGER NOT NULL DEFAULT 0,
    "meanCostCents" INTEGER NOT NULL DEFAULT 0,
    "meanLatencyMs" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'running',
    "metadata" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bench_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bench_task_results" (
    "id" TEXT NOT NULL,
    "benchRunId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "passed" BOOLEAN NOT NULL DEFAULT false,
    "score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "tokens" INTEGER NOT NULL DEFAULT 0,
    "costCents" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "expected" TEXT,
    "actual" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bench_task_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "code_graphs" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "repoConnectionId" TEXT,
    "commitSha" TEXT,
    "symbolCount" INTEGER NOT NULL DEFAULT 0,
    "edgeCount" INTEGER NOT NULL DEFAULT 0,
    "languageStats" TEXT NOT NULL DEFAULT '{}',
    "lastIndexedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "code_graphs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "code_symbols" (
    "id" TEXT NOT NULL,
    "codeGraphId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "qualifiedName" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "startLine" INTEGER NOT NULL,
    "endLine" INTEGER NOT NULL,
    "language" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "source" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "code_symbols_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "code_edges" (
    "id" TEXT NOT NULL,
    "codeGraphId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "fromSymbolId" TEXT NOT NULL,
    "toSymbolId" TEXT,
    "toQualifiedName" TEXT,
    "filePath" TEXT NOT NULL,
    "line" INTEGER NOT NULL,
    "metadata" TEXT,
    "source" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "code_edges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sandbox_sessions" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT,
    "runId" TEXT,
    "provider" TEXT NOT NULL,
    "vendorSandboxId" TEXT NOT NULL,
    "templateId" TEXT,
    "vCpus" INTEGER NOT NULL,
    "memMiB" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "destroyedAt" TIMESTAMP(3),
    "wallClockMs" INTEGER,
    "cpuTimeMs" INTEGER,
    "costMicroUsd" INTEGER,
    "outcome" TEXT,
    "errorMessage" TEXT,

    CONSTRAINT "sandbox_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sandbox_audit_events" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" TEXT NOT NULL DEFAULT '{}',
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sandbox_audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pr_review_state" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "repoOwner" TEXT NOT NULL,
    "repoName" TEXT NOT NULL,
    "prNumber" INTEGER NOT NULL,
    "lastReviewedSha" TEXT,
    "acVerdictsJson" TEXT NOT NULL DEFAULT '[]',
    "lastRunId" TEXT,
    "lastVerdict" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pr_review_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pr_review_webhook_deliveries" (
    "id" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "runId" TEXT,

    CONSTRAINT "pr_review_webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generated_documents" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'full',
    "scopeFilter" TEXT NOT NULL DEFAULT '{}',
    "content" TEXT NOT NULL DEFAULT '',
    "codeGraphHash" TEXT,
    "schemaGraph" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "errorMessage" TEXT,
    "autoUpdate" BOOLEAN NOT NULL DEFAULT false,
    "generatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "generated_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generated_document_versions" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "diffSummary" TEXT,
    "changedSymbols" TEXT NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "generated_document_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "docs_gen_fact_cache" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "cacheKey" TEXT NOT NULL,
    "modulePath" TEXT NOT NULL,
    "fileFingerprint" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersion" INTEGER NOT NULL DEFAULT 1,
    "facts" TEXT NOT NULL,
    "formulasJson" TEXT NOT NULL DEFAULT '[]',
    "minedRulesJson" TEXT NOT NULL DEFAULT '[]',
    "topClassesJson" TEXT NOT NULL DEFAULT '[]',
    "classCount" INTEGER NOT NULL DEFAULT 0,
    "methodCount" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "hitCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "docs_gen_fact_cache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "slug" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_repos" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "repoConnectionId" TEXT NOT NULL,
    "role" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_repos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_edges" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sourceRepoId" TEXT NOT NULL,
    "targetRepoId" TEXT NOT NULL,
    "edgeType" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "evidence" TEXT NOT NULL DEFAULT '[]',
    "sourceFile" TEXT,
    "targetFile" TEXT,
    "commitSha" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_edges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_analyses" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "edgeCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "triggeredBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_analyses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_documents" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "docType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "repoId" TEXT,
    "metadata" TEXT NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jira_connections" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "edition" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "secretId" TEXT NOT NULL,
    "proxyUrl" TEXT,
    "tlsRejectUnauthorized" BOOLEAN NOT NULL DEFAULT true,
    "tlsCaSecretId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'untested',
    "errorMessage" TEXT,
    "lastTestedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "jira_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inference_profiles" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "arn" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "costCenter" TEXT,
    "environment" TEXT,
    "tags" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inference_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "token_budgets" (
    "id" TEXT NOT NULL,
    "projectId" TEXT,
    "userId" TEXT,
    "dailyTokenLimit" INTEGER,
    "monthlyTokenLimit" INTEGER,
    "downgradeModel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "token_budgets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_requests" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reviewerId" TEXT,
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),

    CONSTRAINT "approval_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scanner_rule_sets" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scanner_rule_sets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scanner_rules" (
    "id" TEXT NOT NULL,
    "ruleSetId" TEXT NOT NULL,
    "naturalLanguage" TEXT NOT NULL,
    "compiledMeta" TEXT NOT NULL DEFAULT '',
    "exemplarGrades" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "severity" TEXT NOT NULL DEFAULT 'medium',
    "category" TEXT NOT NULL DEFAULT 'security',
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scanner_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scanner_scans" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "repoConnectionId" TEXT NOT NULL,
    "commitSha" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "mode" TEXT NOT NULL DEFAULT 'rules',
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "totalSymbols" INTEGER NOT NULL DEFAULT 0,
    "scannedSymbols" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "costCents" INTEGER NOT NULL DEFAULT 0,
    "budgetCapTokens" INTEGER NOT NULL DEFAULT 2000000,
    "errorMessage" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scanner_scans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scanner_scan_findings" (
    "id" TEXT NOT NULL,
    "scanId" TEXT NOT NULL,
    "ruleId" TEXT,
    "symbolId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'medium',
    "category" TEXT NOT NULL DEFAULT 'security',
    "evidenceLines" TEXT NOT NULL DEFAULT '[]',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "triageStatus" TEXT NOT NULL DEFAULT 'pending',
    "triageNote" TEXT,
    "triagedAt" TIMESTAMP(3),
    "triagedById" TEXT,
    "materializedFindingId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scanner_scan_findings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scanner_issue_links" (
    "id" TEXT NOT NULL,
    "scanFindingId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "externalUrl" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scanner_issue_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drift_events" (
    "id" TEXT NOT NULL,
    "publishedIssueId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "requirementId" TEXT,
    "source" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "fieldDiffs" TEXT NOT NULL,
    "externalSnapshot" TEXT NOT NULL,
    "localSnapshot" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "resolution" TEXT,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "drift_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_coverage_runs" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "mode" TEXT NOT NULL DEFAULT 'A',
    "contentHash" TEXT NOT NULL,
    "tokenCostCents" INTEGER NOT NULL DEFAULT 0,
    "embeddingTokens" INTEGER NOT NULL DEFAULT 0,
    "judgeTokens" INTEGER NOT NULL DEFAULT 0,
    "suggestionTokens" INTEGER NOT NULL DEFAULT 0,
    "phaseProgress" TEXT NOT NULL DEFAULT '{}',
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "test_coverage_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_case_imports" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "runId" TEXT,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "label" TEXT NOT NULL DEFAULT '',
    "testCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "test_case_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_case_docs" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "sourceImportId" TEXT NOT NULL,
    "externalId" TEXT,
    "title" TEXT NOT NULL,
    "preconditions" TEXT,
    "stepsJson" TEXT NOT NULL DEFAULT '[]',
    "expected" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'medium',
    "tags" TEXT NOT NULL DEFAULT '[]',
    "source" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "test_case_docs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coverage_mappings" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "testCaseDocId" TEXT NOT NULL,
    "cosine" DOUBLE PRECISION NOT NULL,
    "bm25" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "fused" DOUBLE PRECISION NOT NULL,
    "judgeConfidence" DOUBLE PRECISION,
    "status" TEXT NOT NULL,
    "overriddenById" TEXT,
    "overrideReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coverage_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_coverage_gaps" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'medium',
    "meta" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "test_coverage_gaps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_coverage_suggestions" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "mappedRequirementIds" TEXT NOT NULL DEFAULT '[]',
    "title" TEXT NOT NULL,
    "gwtJson" TEXT NOT NULL DEFAULT '{}',
    "stepsJson" TEXT NOT NULL DEFAULT '[]',
    "faithfulness" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sourceChunks" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "lowConfidence" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "test_coverage_suggestions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_management_connections" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "authConfigJson" TEXT NOT NULL DEFAULT '{}',
    "proxyConfigJson" TEXT,
    "tlsConfigJson" TEXT,
    "status" TEXT NOT NULL DEFAULT 'untested',
    "errorMessage" TEXT,
    "lastTestedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "test_management_connections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workspaces_slug_key" ON "workspaces"("slug");

-- CreateIndex
CREATE INDEX "workspaces_slug_idx" ON "workspaces"("slug");

-- CreateIndex
CREATE INDEX "workspace_members_userId_idx" ON "workspace_members"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_members_workspaceId_userId_key" ON "workspace_members"("workspaceId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_invites_token_key" ON "workspace_invites"("token");

-- CreateIndex
CREATE INDEX "workspace_invites_workspaceId_idx" ON "workspace_invites"("workspaceId");

-- CreateIndex
CREATE INDEX "workspace_invites_email_idx" ON "workspace_invites"("email");

-- CreateIndex
CREATE INDEX "workspace_invites_token_idx" ON "workspace_invites"("token");

-- CreateIndex
CREATE INDEX "workspace_usage_daily_workspaceId_date_idx" ON "workspace_usage_daily"("workspaceId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "workspace_usage_daily_workspaceId_date_key" ON "workspace_usage_daily"("workspaceId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_status_idx" ON "users"("status");

-- CreateIndex
CREATE UNIQUE INDEX "roles_key_key" ON "roles"("key");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_key_key" ON "permissions"("key");

-- CreateIndex
CREATE INDEX "user_roles_roleId_idx" ON "user_roles"("roleId");

-- CreateIndex
CREATE INDEX "role_permissions_permissionId_idx" ON "role_permissions"("permissionId");

-- CreateIndex
CREATE INDEX "audit_logs_actorId_ts_idx" ON "audit_logs"("actorId", "ts");

-- CreateIndex
CREATE INDEX "audit_logs_targetType_targetId_idx" ON "audit_logs"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "audit_logs_ts_idx" ON "audit_logs"("ts");

-- CreateIndex
CREATE INDEX "config_audit_key_ts_idx" ON "config_audit"("key", "ts");

-- CreateIndex
CREATE INDEX "config_audit_actorId_ts_idx" ON "config_audit"("actorId", "ts");

-- CreateIndex
CREATE INDEX "runtime_config_scope_idx" ON "runtime_config"("scope");

-- CreateIndex
CREATE UNIQUE INDEX "secrets_name_key" ON "secrets"("name");

-- CreateIndex
CREATE INDEX "secrets_keyVersion_idx" ON "secrets"("keyVersion");

-- CreateIndex
CREATE UNIQUE INDEX "projects_slug_key" ON "projects"("slug");

-- CreateIndex
CREATE INDEX "projects_status_idx" ON "projects"("status");

-- CreateIndex
CREATE INDEX "projects_createdById_idx" ON "projects"("createdById");

-- CreateIndex
CREATE INDEX "projects_workspaceId_idx" ON "projects"("workspaceId");

-- CreateIndex
CREATE INDEX "token_usages_projectId_createdAt_idx" ON "token_usages"("projectId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "model_preferences_projectId_key" ON "model_preferences"("projectId");

-- CreateIndex
CREATE INDEX "model_preferences_projectId_idx" ON "model_preferences"("projectId");

-- CreateIndex
CREATE INDEX "safety_events_projectId_createdAt_idx" ON "safety_events"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "safety_events_projectId_verdict_idx" ON "safety_events"("projectId", "verdict");

-- CreateIndex
CREATE INDEX "documents_projectId_idx" ON "documents"("projectId");

-- CreateIndex
CREATE INDEX "documents_projectId_status_idx" ON "documents"("projectId", "status");

-- CreateIndex
CREATE INDEX "documents_projectId_indexState_idx" ON "documents"("projectId", "indexState");

-- CreateIndex
CREATE INDEX "documents_checksum_idx" ON "documents"("checksum");

-- CreateIndex
CREATE INDEX "knowledge_chunks_projectId_idx" ON "knowledge_chunks"("projectId");

-- CreateIndex
CREATE INDEX "knowledge_chunks_documentId_position_idx" ON "knowledge_chunks"("documentId", "position");

-- CreateIndex
CREATE INDEX "knowledge_chunks_md5_idx" ON "knowledge_chunks"("md5");

-- CreateIndex
CREATE INDEX "quarantine_chunks_projectId_idx" ON "quarantine_chunks"("projectId");

-- CreateIndex
CREATE INDEX "quarantine_chunks_documentId_ord_idx" ON "quarantine_chunks"("documentId", "ord");

-- CreateIndex
CREATE INDEX "chronicle_entries_projectId_key_idx" ON "chronicle_entries"("projectId", "key");

-- CreateIndex
CREATE INDEX "chronicle_entries_expiresAt_idx" ON "chronicle_entries"("expiresAt");

-- CreateIndex
CREATE INDEX "repo_connections_secretId_idx" ON "repo_connections"("secretId");

-- CreateIndex
CREATE INDEX "repo_connections_projectId_status_idx" ON "repo_connections"("projectId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "repo_connections_projectId_label_key" ON "repo_connections"("projectId", "label");

-- CreateIndex
CREATE INDEX "database_connections_secretId_idx" ON "database_connections"("secretId");

-- CreateIndex
CREATE INDEX "database_connections_projectId_status_idx" ON "database_connections"("projectId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "database_connections_projectId_label_key" ON "database_connections"("projectId", "label");

-- CreateIndex
CREATE INDEX "suggested_connectors_projectId_status_idx" ON "suggested_connectors"("projectId", "status");

-- CreateIndex
CREATE INDEX "suggested_connectors_acceptedConnectorId_idx" ON "suggested_connectors"("acceptedConnectorId");

-- CreateIndex
CREATE UNIQUE INDEX "suggested_connectors_projectId_driverType_host_port_databas_key" ON "suggested_connectors"("projectId", "driverType", "host", "port", "database");

-- CreateIndex
CREATE INDEX "analyses_projectId_status_idx" ON "analyses"("projectId", "status");

-- CreateIndex
CREATE INDEX "analyses_status_idx" ON "analyses"("status");

-- CreateIndex
CREATE INDEX "agent_results_analysisId_agentKey_idx" ON "agent_results"("analysisId", "agentKey");

-- CreateIndex
CREATE INDEX "agent_results_status_idx" ON "agent_results"("status");

-- CreateIndex
CREATE UNIQUE INDEX "findings_scanFindingId_key" ON "findings"("scanFindingId");

-- CreateIndex
CREATE INDEX "findings_agentResultId_idx" ON "findings"("agentResultId");

-- CreateIndex
CREATE INDEX "findings_category_severity_idx" ON "findings"("category", "severity");

-- CreateIndex
CREATE INDEX "findings_derivation_idx" ON "findings"("derivation");

-- CreateIndex
CREATE INDEX "findings_symbolId_idx" ON "findings"("symbolId");

-- CreateIndex
CREATE INDEX "requirements_projectId_idx" ON "requirements"("projectId");

-- CreateIndex
CREATE INDEX "requirements_analysisId_idx" ON "requirements"("analysisId");

-- CreateIndex
CREATE INDEX "requirements_parentId_idx" ON "requirements"("parentId");

-- CreateIndex
CREATE INDEX "requirements_implementedByPr_idx" ON "requirements"("implementedByPr");

-- CreateIndex
CREATE INDEX "requirement_implementations_requirementId_idx" ON "requirement_implementations"("requirementId");

-- CreateIndex
CREATE INDEX "requirement_implementations_prNumber_idx" ON "requirement_implementations"("prNumber");

-- CreateIndex
CREATE INDEX "requirement_data_mappings_requirementId_idx" ON "requirement_data_mappings"("requirementId");

-- CreateIndex
CREATE INDEX "requirement_data_mappings_dbConnectorId_idx" ON "requirement_data_mappings"("dbConnectorId");

-- CreateIndex
CREATE UNIQUE INDEX "requirement_data_mappings_requirementId_dbConnectorId_schem_key" ON "requirement_data_mappings"("requirementId", "dbConnectorId", "schemaName", "tableName", "columnName");

-- CreateIndex
CREATE INDEX "issue_drafts_projectId_status_idx" ON "issue_drafts"("projectId", "status");

-- CreateIndex
CREATE INDEX "issue_drafts_requirementId_idx" ON "issue_drafts"("requirementId");

-- CreateIndex
CREATE INDEX "issue_drafts_parentDraftId_idx" ON "issue_drafts"("parentDraftId");

-- CreateIndex
CREATE INDEX "issue_drafts_dedupHash_idx" ON "issue_drafts"("dedupHash");

-- CreateIndex
CREATE INDEX "issue_templates_projectId_platform_idx" ON "issue_templates"("projectId", "platform");

-- CreateIndex
CREATE INDEX "issue_templates_projectId_templateType_idx" ON "issue_templates"("projectId", "templateType");

-- CreateIndex
CREATE INDEX "publish_batches_projectId_status_idx" ON "publish_batches"("projectId", "status");

-- CreateIndex
CREATE INDEX "publish_batches_status_idx" ON "publish_batches"("status");

-- CreateIndex
CREATE INDEX "publish_batches_archived_idx" ON "publish_batches"("archived");

-- CreateIndex
CREATE INDEX "published_issues_batchId_issueNumber_destination_idx" ON "published_issues"("batchId", "issueNumber", "destination");

-- CreateIndex
CREATE INDEX "published_issues_issueId_idx" ON "published_issues"("issueId");

-- CreateIndex
CREATE INDEX "published_issues_dedupHash_idx" ON "published_issues"("dedupHash");

-- CreateIndex
CREATE UNIQUE INDEX "published_issues_batchId_draftId_destination_key" ON "published_issues"("batchId", "draftId", "destination");

-- CreateIndex
CREATE INDEX "change_analyses_projectId_idx" ON "change_analyses"("projectId");

-- CreateIndex
CREATE INDEX "change_analyses_baseAnalysisId_idx" ON "change_analyses"("baseAnalysisId");

-- CreateIndex
CREATE INDEX "change_analyses_headAnalysisId_idx" ON "change_analyses"("headAnalysisId");

-- CreateIndex
CREATE INDEX "requirement_changes_changeAnalysisId_idx" ON "requirement_changes"("changeAnalysisId");

-- CreateIndex
CREATE INDEX "requirement_changes_requirementId_idx" ON "requirement_changes"("requirementId");

-- CreateIndex
CREATE INDEX "requirement_changes_previousRequirementId_idx" ON "requirement_changes"("previousRequirementId");

-- CreateIndex
CREATE INDEX "requirement_changes_reviewStatus_idx" ON "requirement_changes"("reviewStatus");

-- CreateIndex
CREATE INDEX "mcp_servers_scope_idx" ON "mcp_servers"("scope");

-- CreateIndex
CREATE INDEX "mcp_servers_status_idx" ON "mcp_servers"("status");

-- CreateIndex
CREATE INDEX "mcp_servers_userId_idx" ON "mcp_servers"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "mcp_servers_scope_projectId_label_key" ON "mcp_servers"("scope", "projectId", "label");

-- CreateIndex
CREATE INDEX "project_mcp_allowlists_mcpServerId_idx" ON "project_mcp_allowlists"("mcpServerId");

-- CreateIndex
CREATE INDEX "mcp_tool_approvals_sessionId_idx" ON "mcp_tool_approvals"("sessionId");

-- CreateIndex
CREATE INDEX "mcp_tool_approvals_status_idx" ON "mcp_tool_approvals"("status");

-- CreateIndex
CREATE INDEX "mcp_registry_entries_source_idx" ON "mcp_registry_entries"("source");

-- CreateIndex
CREATE INDEX "mcp_registry_entries_fetchedAt_idx" ON "mcp_registry_entries"("fetchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "mcp_registry_entries_source_externalId_key" ON "mcp_registry_entries"("source", "externalId");

-- CreateIndex
CREATE INDEX "spec_kit_artifacts_projectId_idx" ON "spec_kit_artifacts"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "spec_kit_artifacts_projectId_name_key" ON "spec_kit_artifacts"("projectId", "name");

-- CreateIndex
CREATE INDEX "spec_kit_features_projectId_idx" ON "spec_kit_features"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "spec_kit_features_projectId_slug_key" ON "spec_kit_features"("projectId", "slug");

-- CreateIndex
CREATE INDEX "spec_kit_feature_artifacts_featureId_idx" ON "spec_kit_feature_artifacts"("featureId");

-- CreateIndex
CREATE UNIQUE INDEX "spec_kit_feature_artifacts_featureId_key_key" ON "spec_kit_feature_artifacts"("featureId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "spec_kit_constitutions_projectId_key" ON "spec_kit_constitutions"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "spec_kit_configs_projectId_key" ON "spec_kit_configs"("projectId");

-- CreateIndex
CREATE INDEX "spec_kit_task_exports_projectId_featureSlug_idx" ON "spec_kit_task_exports"("projectId", "featureSlug");

-- CreateIndex
CREATE UNIQUE INDEX "spec_kit_task_exports_projectId_featureSlug_taskId_key" ON "spec_kit_task_exports"("projectId", "featureSlug", "taskId");

-- CreateIndex
CREATE UNIQUE INDEX "skills_key_key" ON "skills"("key");

-- CreateIndex
CREATE INDEX "skills_enabled_deletedAt_idx" ON "skills"("enabled", "deletedAt");

-- CreateIndex
CREATE INDEX "skill_versions_skillId_createdAt_idx" ON "skill_versions"("skillId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "skill_versions_skillId_version_key" ON "skill_versions"("skillId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "agents_key_key" ON "agents"("key");

-- CreateIndex
CREATE INDEX "agents_enabled_deletedAt_idx" ON "agents"("enabled", "deletedAt");

-- CreateIndex
CREATE INDEX "agent_versions_agentId_createdAt_idx" ON "agent_versions"("agentId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "agent_versions_agentId_version_key" ON "agent_versions"("agentId", "version");

-- CreateIndex
CREATE INDEX "agent_skills_skillId_idx" ON "agent_skills"("skillId");

-- CreateIndex
CREATE INDEX "project_skill_allowlists_skillId_idx" ON "project_skill_allowlists"("skillId");

-- CreateIndex
CREATE INDEX "project_agent_allowlists_agentId_idx" ON "project_agent_allowlists"("agentId");

-- CreateIndex
CREATE UNIQUE INDEX "scheduled_jobs_key_key" ON "scheduled_jobs"("key");

-- CreateIndex
CREATE INDEX "scheduled_jobs_enabled_nextRunAt_idx" ON "scheduled_jobs"("enabled", "nextRunAt");

-- CreateIndex
CREATE INDEX "scheduled_jobs_projectId_idx" ON "scheduled_jobs"("projectId");

-- CreateIndex
CREATE INDEX "tasks_status_priority_createdAt_idx" ON "tasks"("status", "priority", "createdAt");

-- CreateIndex
CREATE INDEX "tasks_scheduledJobId_idx" ON "tasks"("scheduledJobId");

-- CreateIndex
CREATE INDEX "tasks_type_status_idx" ON "tasks"("type", "status");

-- CreateIndex
CREATE INDEX "tasks_projectId_status_idx" ON "tasks"("projectId", "status");

-- CreateIndex
CREATE INDEX "ai_sessions_userId_idx" ON "ai_sessions"("userId");

-- CreateIndex
CREATE INDEX "ai_sessions_projectId_idx" ON "ai_sessions"("projectId");

-- CreateIndex
CREATE INDEX "ai_sessions_status_idx" ON "ai_sessions"("status");

-- CreateIndex
CREATE INDEX "ai_sessions_agentId_idx" ON "ai_sessions"("agentId");

-- CreateIndex
CREATE INDEX "ai_token_usages_sessionId_ts_idx" ON "ai_token_usages"("sessionId", "ts");

-- CreateIndex
CREATE INDEX "ai_token_usages_userId_dayBucket_idx" ON "ai_token_usages"("userId", "dayBucket");

-- CreateIndex
CREATE INDEX "ai_token_usages_ts_idx" ON "ai_token_usages"("ts");

-- CreateIndex
CREATE INDEX "ai_token_usages_projectId_ts_idx" ON "ai_token_usages"("projectId", "ts");

-- CreateIndex
CREATE INDEX "ai_tool_approvals_sessionId_ts_idx" ON "ai_tool_approvals"("sessionId", "ts");

-- CreateIndex
CREATE INDEX "ai_tool_approvals_toolName_idx" ON "ai_tool_approvals"("toolName");

-- CreateIndex
CREATE INDEX "ai_tool_approvals_userId_ts_idx" ON "ai_tool_approvals"("userId", "ts");

-- CreateIndex
CREATE INDEX "agent_runs_projectId_startedAt_idx" ON "agent_runs"("projectId", "startedAt");

-- CreateIndex
CREATE INDEX "agent_runs_sessionId_startedAt_idx" ON "agent_runs"("sessionId", "startedAt");

-- CreateIndex
CREATE INDEX "agent_runs_status_idx" ON "agent_runs"("status");

-- CreateIndex
CREATE INDEX "agent_run_steps_runId_ord_idx" ON "agent_run_steps"("runId", "ord");

-- CreateIndex
CREATE INDEX "known_agent_definitions_projectId_idx" ON "known_agent_definitions"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "known_agent_definitions_projectId_name_key" ON "known_agent_definitions"("projectId", "name");

-- CreateIndex
CREATE INDEX "custom_agents_projectId_idx" ON "custom_agents"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "custom_agents_projectId_name_key" ON "custom_agents"("projectId", "name");

-- CreateIndex
CREATE INDEX "custom_agent_enablements_projectId_enabled_idx" ON "custom_agent_enablements"("projectId", "enabled");

-- CreateIndex
CREATE INDEX "custom_agent_enablements_customAgentId_idx" ON "custom_agent_enablements"("customAgentId");

-- CreateIndex
CREATE UNIQUE INDEX "custom_agent_enablements_customAgentId_projectId_key" ON "custom_agent_enablements"("customAgentId", "projectId");

-- CreateIndex
CREATE INDEX "hook_subscriptions_projectId_event_idx" ON "hook_subscriptions"("projectId", "event");

-- CreateIndex
CREATE INDEX "hook_subscriptions_enabled_idx" ON "hook_subscriptions"("enabled");

-- CreateIndex
CREATE INDEX "session_plans_sessionId_status_idx" ON "session_plans"("sessionId", "status");

-- CreateIndex
CREATE INDEX "background_runs_projectId_status_idx" ON "background_runs"("projectId", "status");

-- CreateIndex
CREATE INDEX "background_runs_status_priority_idx" ON "background_runs"("status", "priority");

-- CreateIndex
CREATE INDEX "background_runs_runGroupId_idx" ON "background_runs"("runGroupId");

-- CreateIndex
CREATE INDEX "triggers_projectId_source_idx" ON "triggers"("projectId", "source");

-- CreateIndex
CREATE INDEX "triggers_enabled_idx" ON "triggers"("enabled");

-- CreateIndex
CREATE INDEX "run_groups_projectId_status_idx" ON "run_groups"("projectId", "status");

-- CreateIndex
CREATE INDEX "run_messages_runId_ord_idx" ON "run_messages"("runId", "ord");

-- CreateIndex
CREATE INDEX "run_messages_runId_status_idx" ON "run_messages"("runId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "api_tokens_tokenHash_key" ON "api_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "api_tokens_userId_idx" ON "api_tokens"("userId");

-- CreateIndex
CREATE INDEX "api_tokens_revokedAt_idx" ON "api_tokens"("revokedAt");

-- CreateIndex
CREATE INDEX "bench_runs_benchmark_startedAt_idx" ON "bench_runs"("benchmark", "startedAt");

-- CreateIndex
CREATE INDEX "bench_runs_status_idx" ON "bench_runs"("status");

-- CreateIndex
CREATE INDEX "bench_task_results_benchRunId_idx" ON "bench_task_results"("benchRunId");

-- CreateIndex
CREATE INDEX "bench_task_results_taskId_idx" ON "bench_task_results"("taskId");

-- CreateIndex
CREATE INDEX "code_graphs_projectId_idx" ON "code_graphs"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "code_graphs_projectId_repoConnectionId_key" ON "code_graphs"("projectId", "repoConnectionId");

-- CreateIndex
CREATE INDEX "code_symbols_projectId_kind_idx" ON "code_symbols"("projectId", "kind");

-- CreateIndex
CREATE INDEX "code_symbols_projectId_qualifiedName_idx" ON "code_symbols"("projectId", "qualifiedName");

-- CreateIndex
CREATE INDEX "code_symbols_codeGraphId_filePath_idx" ON "code_symbols"("codeGraphId", "filePath");

-- CreateIndex
CREATE INDEX "code_edges_fromSymbolId_kind_idx" ON "code_edges"("fromSymbolId", "kind");

-- CreateIndex
CREATE INDEX "code_edges_toSymbolId_kind_idx" ON "code_edges"("toSymbolId", "kind");

-- CreateIndex
CREATE INDEX "code_edges_projectId_kind_idx" ON "code_edges"("projectId", "kind");

-- CreateIndex
CREATE INDEX "code_edges_codeGraphId_filePath_idx" ON "code_edges"("codeGraphId", "filePath");

-- CreateIndex
CREATE INDEX "sandbox_sessions_projectId_createdAt_idx" ON "sandbox_sessions"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "sandbox_sessions_userId_createdAt_idx" ON "sandbox_sessions"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "sandbox_sessions_runId_createdAt_idx" ON "sandbox_sessions"("runId", "createdAt");

-- CreateIndex
CREATE INDEX "sandbox_audit_events_sessionId_timestamp_idx" ON "sandbox_audit_events"("sessionId", "timestamp");

-- CreateIndex
CREATE INDEX "sandbox_audit_events_eventType_timestamp_idx" ON "sandbox_audit_events"("eventType", "timestamp");

-- CreateIndex
CREATE INDEX "pr_review_state_projectId_updatedAt_idx" ON "pr_review_state"("projectId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "pr_review_state_projectId_repoOwner_repoName_prNumber_key" ON "pr_review_state"("projectId", "repoOwner", "repoName", "prNumber");

-- CreateIndex
CREATE UNIQUE INDEX "pr_review_webhook_deliveries_deliveryId_key" ON "pr_review_webhook_deliveries"("deliveryId");

-- CreateIndex
CREATE INDEX "pr_review_webhook_deliveries_receivedAt_idx" ON "pr_review_webhook_deliveries"("receivedAt");

-- CreateIndex
CREATE INDEX "generated_documents_projectId_status_idx" ON "generated_documents"("projectId", "status");

-- CreateIndex
CREATE INDEX "generated_documents_projectId_scope_idx" ON "generated_documents"("projectId", "scope");

-- CreateIndex
CREATE INDEX "generated_document_versions_documentId_version_idx" ON "generated_document_versions"("documentId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "generated_document_versions_documentId_version_key" ON "generated_document_versions"("documentId", "version");

-- CreateIndex
CREATE INDEX "docs_gen_fact_cache_projectId_modulePath_idx" ON "docs_gen_fact_cache"("projectId", "modulePath");

-- CreateIndex
CREATE INDEX "docs_gen_fact_cache_lastUsedAt_idx" ON "docs_gen_fact_cache"("lastUsedAt");

-- CreateIndex
CREATE UNIQUE INDEX "docs_gen_fact_cache_projectId_cacheKey_key" ON "docs_gen_fact_cache"("projectId", "cacheKey");

-- CreateIndex
CREATE UNIQUE INDEX "products_slug_key" ON "products"("slug");

-- CreateIndex
CREATE INDEX "products_createdById_idx" ON "products"("createdById");

-- CreateIndex
CREATE INDEX "product_repos_repoConnectionId_idx" ON "product_repos"("repoConnectionId");

-- CreateIndex
CREATE UNIQUE INDEX "product_repos_productId_repoConnectionId_key" ON "product_repos"("productId", "repoConnectionId");

-- CreateIndex
CREATE INDEX "product_edges_productId_idx" ON "product_edges"("productId");

-- CreateIndex
CREATE INDEX "product_edges_sourceRepoId_idx" ON "product_edges"("sourceRepoId");

-- CreateIndex
CREATE INDEX "product_edges_targetRepoId_idx" ON "product_edges"("targetRepoId");

-- CreateIndex
CREATE INDEX "product_edges_productId_edgeType_idx" ON "product_edges"("productId", "edgeType");

-- CreateIndex
CREATE INDEX "product_analyses_productId_idx" ON "product_analyses"("productId");

-- CreateIndex
CREATE INDEX "product_documents_productId_idx" ON "product_documents"("productId");

-- CreateIndex
CREATE INDEX "product_documents_productId_docType_idx" ON "product_documents"("productId", "docType");

-- CreateIndex
CREATE INDEX "product_documents_repoId_idx" ON "product_documents"("repoId");

-- CreateIndex
CREATE INDEX "jira_connections_projectId_idx" ON "jira_connections"("projectId");

-- CreateIndex
CREATE INDEX "jira_connections_createdById_idx" ON "jira_connections"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "jira_connections_projectId_label_key" ON "jira_connections"("projectId", "label");

-- CreateIndex
CREATE UNIQUE INDEX "inference_profiles_projectId_key" ON "inference_profiles"("projectId");

-- CreateIndex
CREATE INDEX "inference_profiles_projectId_idx" ON "inference_profiles"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "token_budgets_projectId_key" ON "token_budgets"("projectId");

-- CreateIndex
CREATE INDEX "token_budgets_projectId_idx" ON "token_budgets"("projectId");

-- CreateIndex
CREATE INDEX "token_budgets_userId_idx" ON "token_budgets"("userId");

-- CreateIndex
CREATE INDEX "approval_requests_analysisId_status_idx" ON "approval_requests"("analysisId", "status");

-- CreateIndex
CREATE INDEX "approval_requests_status_idx" ON "approval_requests"("status");

-- CreateIndex
CREATE INDEX "scanner_rule_sets_projectId_isActive_idx" ON "scanner_rule_sets"("projectId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "scanner_rule_sets_projectId_name_key" ON "scanner_rule_sets"("projectId", "name");

-- CreateIndex
CREATE INDEX "scanner_rules_ruleSetId_idx" ON "scanner_rules"("ruleSetId");

-- CreateIndex
CREATE INDEX "scanner_rules_status_idx" ON "scanner_rules"("status");

-- CreateIndex
CREATE INDEX "scanner_scans_projectId_status_idx" ON "scanner_scans"("projectId", "status");

-- CreateIndex
CREATE INDEX "scanner_scans_repoConnectionId_createdAt_idx" ON "scanner_scans"("repoConnectionId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "scanner_scan_findings_materializedFindingId_key" ON "scanner_scan_findings"("materializedFindingId");

-- CreateIndex
CREATE INDEX "scanner_scan_findings_scanId_triageStatus_idx" ON "scanner_scan_findings"("scanId", "triageStatus");

-- CreateIndex
CREATE INDEX "scanner_scan_findings_symbolId_idx" ON "scanner_scan_findings"("symbolId");

-- CreateIndex
CREATE INDEX "scanner_scan_findings_fingerprint_idx" ON "scanner_scan_findings"("fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "scanner_scan_findings_scanId_fingerprint_key" ON "scanner_scan_findings"("scanId", "fingerprint");

-- CreateIndex
CREATE INDEX "scanner_issue_links_provider_externalId_idx" ON "scanner_issue_links"("provider", "externalId");

-- CreateIndex
CREATE INDEX "scanner_issue_links_fingerprint_idx" ON "scanner_issue_links"("fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "scanner_issue_links_scanFindingId_provider_key" ON "scanner_issue_links"("scanFindingId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "drift_events_deliveryId_key" ON "drift_events"("deliveryId");

-- CreateIndex
CREATE INDEX "drift_events_projectId_status_idx" ON "drift_events"("projectId", "status");

-- CreateIndex
CREATE INDEX "drift_events_publishedIssueId_idx" ON "drift_events"("publishedIssueId");

-- CreateIndex
CREATE INDEX "drift_events_source_idx" ON "drift_events"("source");

-- CreateIndex
CREATE INDEX "test_coverage_runs_projectId_status_idx" ON "test_coverage_runs"("projectId", "status");

-- CreateIndex
CREATE INDEX "test_coverage_runs_contentHash_idx" ON "test_coverage_runs"("contentHash");

-- CreateIndex
CREATE INDEX "test_case_imports_projectId_status_idx" ON "test_case_imports"("projectId", "status");

-- CreateIndex
CREATE INDEX "test_case_imports_runId_idx" ON "test_case_imports"("runId");

-- CreateIndex
CREATE INDEX "test_case_docs_projectId_contentHash_idx" ON "test_case_docs"("projectId", "contentHash");

-- CreateIndex
CREATE UNIQUE INDEX "test_case_docs_projectId_source_externalId_key" ON "test_case_docs"("projectId", "source", "externalId");

-- CreateIndex
CREATE INDEX "coverage_mappings_runId_status_idx" ON "coverage_mappings"("runId", "status");

-- CreateIndex
CREATE INDEX "coverage_mappings_requirementId_idx" ON "coverage_mappings"("requirementId");

-- CreateIndex
CREATE UNIQUE INDEX "coverage_mappings_runId_requirementId_testCaseDocId_key" ON "coverage_mappings"("runId", "requirementId", "testCaseDocId");

-- CreateIndex
CREATE INDEX "test_coverage_gaps_runId_severity_idx" ON "test_coverage_gaps"("runId", "severity");

-- CreateIndex
CREATE UNIQUE INDEX "test_coverage_gaps_runId_requirementId_key" ON "test_coverage_gaps"("runId", "requirementId");

-- CreateIndex
CREATE INDEX "test_coverage_suggestions_runId_status_idx" ON "test_coverage_suggestions"("runId", "status");

-- CreateIndex
CREATE INDEX "test_management_connections_projectId_idx" ON "test_management_connections"("projectId");

-- CreateIndex
CREATE INDEX "test_management_connections_projectId_kind_idx" ON "test_management_connections"("projectId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "test_management_connections_projectId_label_key" ON "test_management_connections"("projectId", "label");

-- AddForeignKey
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_invites" ADD CONSTRAINT "workspace_invites_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_invites" ADD CONSTRAINT "workspace_invites_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_usage_daily" ADD CONSTRAINT "workspace_usage_daily_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runtime_config" ADD CONSTRAINT "runtime_config_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_jiraConnectionId_fkey" FOREIGN KEY ("jiraConnectionId") REFERENCES "jira_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_usages" ADD CONSTRAINT "token_usages_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_preferences" ADD CONSTRAINT "model_preferences_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "safety_events" ADD CONSTRAINT "safety_events_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quarantine_chunks" ADD CONSTRAINT "quarantine_chunks_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quarantine_chunks" ADD CONSTRAINT "quarantine_chunks_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chronicle_entries" ADD CONSTRAINT "chronicle_entries_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repo_connections" ADD CONSTRAINT "repo_connections_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repo_connections" ADD CONSTRAINT "repo_connections_secretId_fkey" FOREIGN KEY ("secretId") REFERENCES "secrets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repo_connections" ADD CONSTRAINT "repo_connections_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "database_connections" ADD CONSTRAINT "database_connections_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "database_connections" ADD CONSTRAINT "database_connections_secretId_fkey" FOREIGN KEY ("secretId") REFERENCES "secrets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "database_connections" ADD CONSTRAINT "database_connections_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suggested_connectors" ADD CONSTRAINT "suggested_connectors_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analyses" ADD CONSTRAINT "analyses_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analyses" ADD CONSTRAINT "analyses_startedById_fkey" FOREIGN KEY ("startedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_results" ADD CONSTRAINT "agent_results_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "analyses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "findings" ADD CONSTRAINT "findings_agentResultId_fkey" FOREIGN KEY ("agentResultId") REFERENCES "agent_results"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "findings" ADD CONSTRAINT "findings_symbolId_fkey" FOREIGN KEY ("symbolId") REFERENCES "code_symbols"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "findings" ADD CONSTRAINT "findings_scanFindingId_fkey" FOREIGN KEY ("scanFindingId") REFERENCES "scanner_scan_findings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requirements" ADD CONSTRAINT "requirements_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requirements" ADD CONSTRAINT "requirements_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "analyses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requirements" ADD CONSTRAINT "requirements_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "requirements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requirement_implementations" ADD CONSTRAINT "requirement_implementations_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "requirements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requirement_data_mappings" ADD CONSTRAINT "requirement_data_mappings_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "requirements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requirement_data_mappings" ADD CONSTRAINT "requirement_data_mappings_dbConnectorId_fkey" FOREIGN KEY ("dbConnectorId") REFERENCES "database_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issue_drafts" ADD CONSTRAINT "issue_drafts_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issue_drafts" ADD CONSTRAINT "issue_drafts_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "requirements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issue_drafts" ADD CONSTRAINT "issue_drafts_parentDraftId_fkey" FOREIGN KEY ("parentDraftId") REFERENCES "issue_drafts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issue_templates" ADD CONSTRAINT "issue_templates_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publish_batches" ADD CONSTRAINT "publish_batches_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publish_batches" ADD CONSTRAINT "publish_batches_startedById_fkey" FOREIGN KEY ("startedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "published_issues" ADD CONSTRAINT "published_issues_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "publish_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "published_issues" ADD CONSTRAINT "published_issues_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "issue_drafts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_analyses" ADD CONSTRAINT "change_analyses_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_analyses" ADD CONSTRAINT "change_analyses_baseAnalysisId_fkey" FOREIGN KEY ("baseAnalysisId") REFERENCES "analyses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_analyses" ADD CONSTRAINT "change_analyses_headAnalysisId_fkey" FOREIGN KEY ("headAnalysisId") REFERENCES "analyses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_analyses" ADD CONSTRAINT "change_analyses_startedById_fkey" FOREIGN KEY ("startedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requirement_changes" ADD CONSTRAINT "requirement_changes_changeAnalysisId_fkey" FOREIGN KEY ("changeAnalysisId") REFERENCES "change_analyses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requirement_changes" ADD CONSTRAINT "requirement_changes_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "requirements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requirement_changes" ADD CONSTRAINT "requirement_changes_previousRequirementId_fkey" FOREIGN KEY ("previousRequirementId") REFERENCES "requirements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_envSecretId_fkey" FOREIGN KEY ("envSecretId") REFERENCES "secrets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_mcp_allowlists" ADD CONSTRAINT "project_mcp_allowlists_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_mcp_allowlists" ADD CONSTRAINT "project_mcp_allowlists_mcpServerId_fkey" FOREIGN KEY ("mcpServerId") REFERENCES "mcp_servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_tool_approvals" ADD CONSTRAINT "mcp_tool_approvals_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "mcp_servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_tool_approvals" ADD CONSTRAINT "mcp_tool_approvals_decidedBy_fkey" FOREIGN KEY ("decidedBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "spec_kit_artifacts" ADD CONSTRAINT "spec_kit_artifacts_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "spec_kit_features" ADD CONSTRAINT "spec_kit_features_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "spec_kit_feature_artifacts" ADD CONSTRAINT "spec_kit_feature_artifacts_featureId_fkey" FOREIGN KEY ("featureId") REFERENCES "spec_kit_features"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skills" ADD CONSTRAINT "skills_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "skills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "skills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_skill_allowlists" ADD CONSTRAINT "project_skill_allowlists_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_skill_allowlists" ADD CONSTRAINT "project_skill_allowlists_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "skills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_agent_allowlists" ADD CONSTRAINT "project_agent_allowlists_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_agent_allowlists" ADD CONSTRAINT "project_agent_allowlists_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_jobs" ADD CONSTRAINT "scheduled_jobs_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_scheduledJobId_fkey" FOREIGN KEY ("scheduledJobId") REFERENCES "scheduled_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_sessions" ADD CONSTRAINT "ai_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_sessions" ADD CONSTRAINT "ai_sessions_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_sessions" ADD CONSTRAINT "ai_sessions_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_token_usages" ADD CONSTRAINT "ai_token_usages_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ai_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_token_usages" ADD CONSTRAINT "ai_token_usages_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_tool_approvals" ADD CONSTRAINT "ai_tool_approvals_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ai_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_tool_approvals" ADD CONSTRAINT "ai_tool_approvals_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_run_steps" ADD CONSTRAINT "agent_run_steps_runId_fkey" FOREIGN KEY ("runId") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_agents" ADD CONSTRAINT "custom_agents_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_agent_enablements" ADD CONSTRAINT "custom_agent_enablements_customAgentId_fkey" FOREIGN KEY ("customAgentId") REFERENCES "custom_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_agent_enablements" ADD CONSTRAINT "custom_agent_enablements_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hook_subscriptions" ADD CONSTRAINT "hook_subscriptions_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_plans" ADD CONSTRAINT "session_plans_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ai_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "background_runs" ADD CONSTRAINT "background_runs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "background_runs" ADD CONSTRAINT "background_runs_runGroupId_fkey" FOREIGN KEY ("runGroupId") REFERENCES "run_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "triggers" ADD CONSTRAINT "triggers_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_groups" ADD CONSTRAINT "run_groups_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_messages" ADD CONSTRAINT "run_messages_runId_fkey" FOREIGN KEY ("runId") REFERENCES "background_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bench_task_results" ADD CONSTRAINT "bench_task_results_benchRunId_fkey" FOREIGN KEY ("benchRunId") REFERENCES "bench_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "code_graphs" ADD CONSTRAINT "code_graphs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "code_graphs" ADD CONSTRAINT "code_graphs_repoConnectionId_fkey" FOREIGN KEY ("repoConnectionId") REFERENCES "repo_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "code_symbols" ADD CONSTRAINT "code_symbols_codeGraphId_fkey" FOREIGN KEY ("codeGraphId") REFERENCES "code_graphs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "code_symbols" ADD CONSTRAINT "code_symbols_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "code_edges" ADD CONSTRAINT "code_edges_codeGraphId_fkey" FOREIGN KEY ("codeGraphId") REFERENCES "code_graphs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "code_edges" ADD CONSTRAINT "code_edges_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "code_edges" ADD CONSTRAINT "code_edges_fromSymbolId_fkey" FOREIGN KEY ("fromSymbolId") REFERENCES "code_symbols"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "code_edges" ADD CONSTRAINT "code_edges_toSymbolId_fkey" FOREIGN KEY ("toSymbolId") REFERENCES "code_symbols"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sandbox_sessions" ADD CONSTRAINT "sandbox_sessions_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sandbox_sessions" ADD CONSTRAINT "sandbox_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sandbox_audit_events" ADD CONSTRAINT "sandbox_audit_events_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sandbox_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pr_review_state" ADD CONSTRAINT "pr_review_state_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generated_documents" ADD CONSTRAINT "generated_documents_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generated_document_versions" ADD CONSTRAINT "generated_document_versions_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "generated_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "docs_gen_fact_cache" ADD CONSTRAINT "docs_gen_fact_cache_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_repos" ADD CONSTRAINT "product_repos_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_repos" ADD CONSTRAINT "product_repos_repoConnectionId_fkey" FOREIGN KEY ("repoConnectionId") REFERENCES "repo_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_edges" ADD CONSTRAINT "product_edges_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_edges" ADD CONSTRAINT "product_edges_sourceRepoId_fkey" FOREIGN KEY ("sourceRepoId") REFERENCES "repo_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_edges" ADD CONSTRAINT "product_edges_targetRepoId_fkey" FOREIGN KEY ("targetRepoId") REFERENCES "repo_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_analyses" ADD CONSTRAINT "product_analyses_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_documents" ADD CONSTRAINT "product_documents_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_documents" ADD CONSTRAINT "product_documents_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "repo_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jira_connections" ADD CONSTRAINT "jira_connections_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jira_connections" ADD CONSTRAINT "jira_connections_secretId_fkey" FOREIGN KEY ("secretId") REFERENCES "secrets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jira_connections" ADD CONSTRAINT "jira_connections_tlsCaSecretId_fkey" FOREIGN KEY ("tlsCaSecretId") REFERENCES "secrets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jira_connections" ADD CONSTRAINT "jira_connections_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inference_profiles" ADD CONSTRAINT "inference_profiles_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_budgets" ADD CONSTRAINT "token_budgets_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "analyses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scanner_rule_sets" ADD CONSTRAINT "scanner_rule_sets_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scanner_rule_sets" ADD CONSTRAINT "scanner_rule_sets_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scanner_rules" ADD CONSTRAINT "scanner_rules_ruleSetId_fkey" FOREIGN KEY ("ruleSetId") REFERENCES "scanner_rule_sets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scanner_scans" ADD CONSTRAINT "scanner_scans_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scanner_scans" ADD CONSTRAINT "scanner_scans_repoConnectionId_fkey" FOREIGN KEY ("repoConnectionId") REFERENCES "repo_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scanner_scans" ADD CONSTRAINT "scanner_scans_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scanner_scan_findings" ADD CONSTRAINT "scanner_scan_findings_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "scanner_scans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scanner_scan_findings" ADD CONSTRAINT "scanner_scan_findings_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "scanner_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scanner_scan_findings" ADD CONSTRAINT "scanner_scan_findings_symbolId_fkey" FOREIGN KEY ("symbolId") REFERENCES "code_symbols"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scanner_scan_findings" ADD CONSTRAINT "scanner_scan_findings_triagedById_fkey" FOREIGN KEY ("triagedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scanner_issue_links" ADD CONSTRAINT "scanner_issue_links_scanFindingId_fkey" FOREIGN KEY ("scanFindingId") REFERENCES "scanner_scan_findings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drift_events" ADD CONSTRAINT "drift_events_publishedIssueId_fkey" FOREIGN KEY ("publishedIssueId") REFERENCES "published_issues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drift_events" ADD CONSTRAINT "drift_events_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_coverage_runs" ADD CONSTRAINT "test_coverage_runs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_case_imports" ADD CONSTRAINT "test_case_imports_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_case_imports" ADD CONSTRAINT "test_case_imports_runId_fkey" FOREIGN KEY ("runId") REFERENCES "test_coverage_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_case_docs" ADD CONSTRAINT "test_case_docs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_case_docs" ADD CONSTRAINT "test_case_docs_sourceImportId_fkey" FOREIGN KEY ("sourceImportId") REFERENCES "test_case_imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coverage_mappings" ADD CONSTRAINT "coverage_mappings_runId_fkey" FOREIGN KEY ("runId") REFERENCES "test_coverage_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coverage_mappings" ADD CONSTRAINT "coverage_mappings_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "requirements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coverage_mappings" ADD CONSTRAINT "coverage_mappings_testCaseDocId_fkey" FOREIGN KEY ("testCaseDocId") REFERENCES "test_case_docs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_coverage_gaps" ADD CONSTRAINT "test_coverage_gaps_runId_fkey" FOREIGN KEY ("runId") REFERENCES "test_coverage_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_coverage_gaps" ADD CONSTRAINT "test_coverage_gaps_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "requirements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_coverage_suggestions" ADD CONSTRAINT "test_coverage_suggestions_runId_fkey" FOREIGN KEY ("runId") REFERENCES "test_coverage_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_management_connections" ADD CONSTRAINT "test_management_connections_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Epic #776: Inbound importers (GitHub / Jira / Azure DevOps / Linear).
-- Requirement provenance + dedup columns (nullable; NULLs distinct in the
-- unique index so existing rows never collide).
ALTER TABLE "requirements" ADD COLUMN "externalSource" TEXT;
ALTER TABLE "requirements" ADD COLUMN "externalId" TEXT;
ALTER TABLE "requirements" ADD COLUMN "externalUrl" TEXT;
ALTER TABLE "requirements" ADD COLUMN "importSourceId" TEXT;

CREATE INDEX "requirements_importSourceId_idx" ON "requirements"("importSourceId");
CREATE UNIQUE INDEX "requirements_projectId_externalSource_externalId_key" ON "requirements"("projectId", "externalSource", "externalId");

-- CreateTable
CREATE TABLE "import_sources" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "filter" TEXT NOT NULL DEFAULT '{}',
    "baseUrl" TEXT,
    "jiraConnectionId" TEXT,
    "secretId" TEXT,
    "syncEnabled" BOOLEAN NOT NULL DEFAULT false,
    "syncIntervalMinutes" INTEGER NOT NULL DEFAULT 15,
    "scheduledJobId" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "disabledReason" TEXT,
    "lastRunAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "import_sources_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "import_sources_projectId_idx" ON "import_sources"("projectId");

-- CreateIndex
CREATE INDEX "import_sources_analysisId_idx" ON "import_sources"("analysisId");

-- CreateTable
CREATE TABLE "import_runs" (
    "id" TEXT NOT NULL,
    "importSourceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL DEFAULT 'manual',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "taskId" TEXT,
    "createdCount" INTEGER NOT NULL DEFAULT 0,
    "updatedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "totalFetched" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "import_runs_importSourceId_idx" ON "import_runs"("importSourceId");

-- CreateIndex
CREATE INDEX "import_runs_projectId_createdAt_idx" ON "import_runs"("projectId", "createdAt");

-- AddForeignKey
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_importSourceId_fkey" FOREIGN KEY ("importSourceId") REFERENCES "import_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Epic #728: Multi-User Collaboration
CREATE TABLE "comment_threads" (
    "id" TEXT NOT NULL,
    "requirementId" TEXT,
    "specKitProjectId" TEXT,
    "specKitArtifactName" TEXT,
    "title" TEXT,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "comment_threads_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "comments" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "editedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "comments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "mentions" (
    "id" TEXT NOT NULL,
    "commentId" TEXT NOT NULL,
    "mentionedUserId" TEXT NOT NULL,
    "notified" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "mentions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "assignments" (
    "id" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "assigneeId" TEXT NOT NULL,
    "assignedById" TEXT NOT NULL,
    "slaDeadline" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "assignments_pkey" PRIMARY KEY ("id")
);


-- Epic #770: append-only per-Requirement version history
CREATE TABLE "requirement_versions" (
    "id" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "changedFields" TEXT NOT NULL,
    "actorId" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "requirement_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "requirement_versions_requirementId_idx" ON "requirement_versions"("requirementId");

-- CreateIndex
CREATE INDEX "requirement_versions_actorId_idx" ON "requirement_versions"("actorId");

-- CreateIndex
CREATE UNIQUE INDEX "requirement_versions_requirementId_version_key" ON "requirement_versions"("requirementId", "version");

-- AddForeignKey
ALTER TABLE "requirement_versions" ADD CONSTRAINT "requirement_versions_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "requirements"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Epic #159: multi-project requirement-change → code-impact analysis.
CREATE TABLE "requirement_code_mappings" (
    "id" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "codeSymbolId" TEXT,
    "filePath" TEXT NOT NULL,
    "startLine" INTEGER,
    "endLine" INTEGER,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
    "source" TEXT NOT NULL DEFAULT 'semantic',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "requirement_code_mappings_pkey" PRIMARY KEY ("id")
);

-- Epic #207 — requirement→spec→code traceability spine.
CREATE TABLE "requirement_spec_mappings" (
    "id" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "specDocumentId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
    "source" TEXT NOT NULL DEFAULT 'derived',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "requirement_spec_mappings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "spec_code_mappings" (
    "id" TEXT NOT NULL,
    "specDocumentId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "codeSymbolId" TEXT,
    "filePath" TEXT NOT NULL,
    "startLine" INTEGER,
    "endLine" INTEGER,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
    "source" TEXT NOT NULL DEFAULT 'derived',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "spec_code_mappings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "impact_analyses" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "documentId" TEXT,
    "sourceText" TEXT,
    "summary" TEXT,
    "startedById" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "totalImpactedSymbols" INTEGER NOT NULL DEFAULT 0,
    -- Issue #965 (Epic #960) — drift re-run lineage (self-relation).
    "rerunOfId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "impact_analyses_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "impact_items" (
    "id" TEXT NOT NULL,
    "impactAnalysisId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "requirementId" TEXT,
    "requirementTitle" TEXT,
    "changeType" TEXT NOT NULL DEFAULT 'modified',
    "severity" TEXT NOT NULL DEFAULT 'medium',
    "impactScore" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "affectedFileCount" INTEGER NOT NULL DEFAULT 0,
    "affectedSymbolCount" INTEGER NOT NULL DEFAULT 0,
    "summary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "impact_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "impact_affected_symbols" (
    "id" TEXT NOT NULL,
    "impactItemId" TEXT NOT NULL,
    "codeSymbolId" TEXT,
    "filePath" TEXT NOT NULL,
    "qualifiedName" TEXT NOT NULL,
    "startLine" INTEGER,
    "endLine" INTEGER,
    "relation" TEXT NOT NULL DEFAULT 'direct',
    "depth" INTEGER NOT NULL DEFAULT 0,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    CONSTRAINT "impact_affected_symbols_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "impact_affected_tables" (
    "id" TEXT NOT NULL,
    "impactItemId" TEXT NOT NULL,
    "tableName" TEXT NOT NULL,
    "columnName" TEXT,
    "columnType" TEXT,
    "changeKind" TEXT NOT NULL DEFAULT 'reference',
    "suggestedDdl" TEXT,
    "source" TEXT NOT NULL DEFAULT 'mybatis',
    "reconciliation" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "relevanceTier" TEXT,
    "relevanceRationale" TEXT,
    "consumerResolution" TEXT,
    "riskClass" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "impact_affected_tables_pkey" PRIMARY KEY ("id")
);

-- Epic #954 (#956) — cross-project shared-table consumers.
CREATE TABLE "impact_affected_table_consumers" (
    "id" TEXT NOT NULL,
    "affectedTableId" TEXT NOT NULL,
    "consumerProjectId" TEXT NOT NULL,
    "consumerProjectName" TEXT NOT NULL,
    "usage" TEXT NOT NULL DEFAULT 'readBy',
    "objectQualifiedName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "impact_affected_table_consumers_pkey" PRIMARY KEY ("id")
);

-- Issue #966 (Epic #960) — BA relevance feedback on affected tables.
CREATE TABLE "impact_table_feedback" (
    "id" TEXT NOT NULL,
    "impactAnalysisId" TEXT NOT NULL,
    "impactItemId" TEXT NOT NULL,
    "tableName" TEXT NOT NULL,
    "columnName" TEXT,
    "verdict" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "userDisplayName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "impact_table_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "requirement_code_mappings_requirementId_idx" ON "requirement_code_mappings"("requirementId");
CREATE INDEX "requirement_code_mappings_projectId_idx" ON "requirement_code_mappings"("projectId");
CREATE INDEX "requirement_code_mappings_codeSymbolId_idx" ON "requirement_code_mappings"("codeSymbolId");

-- Epic #207 — traceability spine indexes.
CREATE INDEX "requirement_spec_mappings_requirementId_idx" ON "requirement_spec_mappings"("requirementId");
CREATE INDEX "requirement_spec_mappings_specDocumentId_idx" ON "requirement_spec_mappings"("specDocumentId");
CREATE INDEX "requirement_spec_mappings_projectId_idx" ON "requirement_spec_mappings"("projectId");
CREATE UNIQUE INDEX "requirement_spec_mappings_requirementId_specDocumentId_key" ON "requirement_spec_mappings"("requirementId", "specDocumentId");
CREATE INDEX "spec_code_mappings_specDocumentId_idx" ON "spec_code_mappings"("specDocumentId");
CREATE INDEX "spec_code_mappings_projectId_idx" ON "spec_code_mappings"("projectId");
CREATE INDEX "spec_code_mappings_codeSymbolId_idx" ON "spec_code_mappings"("codeSymbolId");
CREATE INDEX "impact_analyses_documentId_idx" ON "impact_analyses"("documentId");
CREATE INDEX "impact_analyses_startedById_idx" ON "impact_analyses"("startedById");
CREATE INDEX "impact_analyses_status_idx" ON "impact_analyses"("status");
CREATE INDEX "impact_analyses_rerunOfId_idx" ON "impact_analyses"("rerunOfId");
CREATE INDEX "impact_items_impactAnalysisId_idx" ON "impact_items"("impactAnalysisId");
CREATE INDEX "impact_items_projectId_idx" ON "impact_items"("projectId");
CREATE INDEX "impact_items_requirementId_idx" ON "impact_items"("requirementId");
CREATE INDEX "impact_affected_symbols_impactItemId_idx" ON "impact_affected_symbols"("impactItemId");
CREATE INDEX "impact_affected_symbols_codeSymbolId_idx" ON "impact_affected_symbols"("codeSymbolId");
CREATE INDEX "impact_affected_tables_impactItemId_idx" ON "impact_affected_tables"("impactItemId");
CREATE INDEX "impact_affected_table_consumers_affectedTableId_idx" ON "impact_affected_table_consumers"("affectedTableId");
CREATE UNIQUE INDEX "impact_table_feedback_impactItemId_tableName_columnName_userId_key" ON "impact_table_feedback"("impactItemId", "tableName", "columnName", "userId");
CREATE INDEX "impact_table_feedback_impactAnalysisId_idx" ON "impact_table_feedback"("impactAnalysisId");
CREATE INDEX "impact_table_feedback_impactItemId_idx" ON "impact_table_feedback"("impactItemId");

-- AddForeignKey
ALTER TABLE "requirement_code_mappings" ADD CONSTRAINT "requirement_code_mappings_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "requirements"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "requirement_code_mappings" ADD CONSTRAINT "requirement_code_mappings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "requirement_code_mappings" ADD CONSTRAINT "requirement_code_mappings_codeSymbolId_fkey" FOREIGN KEY ("codeSymbolId") REFERENCES "code_symbols"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Epic #207 — traceability spine foreign keys.
ALTER TABLE "requirement_spec_mappings" ADD CONSTRAINT "requirement_spec_mappings_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "requirements"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "requirement_spec_mappings" ADD CONSTRAINT "requirement_spec_mappings_specDocumentId_fkey" FOREIGN KEY ("specDocumentId") REFERENCES "generated_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "requirement_spec_mappings" ADD CONSTRAINT "requirement_spec_mappings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "spec_code_mappings" ADD CONSTRAINT "spec_code_mappings_specDocumentId_fkey" FOREIGN KEY ("specDocumentId") REFERENCES "generated_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "spec_code_mappings" ADD CONSTRAINT "spec_code_mappings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "spec_code_mappings" ADD CONSTRAINT "spec_code_mappings_codeSymbolId_fkey" FOREIGN KEY ("codeSymbolId") REFERENCES "code_symbols"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "impact_analyses" ADD CONSTRAINT "impact_analyses_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "impact_analyses" ADD CONSTRAINT "impact_analyses_startedById_fkey" FOREIGN KEY ("startedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "impact_analyses" ADD CONSTRAINT "impact_analyses_rerunOfId_fkey" FOREIGN KEY ("rerunOfId") REFERENCES "impact_analyses"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "impact_items" ADD CONSTRAINT "impact_items_impactAnalysisId_fkey" FOREIGN KEY ("impactAnalysisId") REFERENCES "impact_analyses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "impact_items" ADD CONSTRAINT "impact_items_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "impact_items" ADD CONSTRAINT "impact_items_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "requirements"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "impact_affected_symbols" ADD CONSTRAINT "impact_affected_symbols_impactItemId_fkey" FOREIGN KEY ("impactItemId") REFERENCES "impact_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "impact_affected_symbols" ADD CONSTRAINT "impact_affected_symbols_codeSymbolId_fkey" FOREIGN KEY ("codeSymbolId") REFERENCES "code_symbols"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "impact_affected_tables" ADD CONSTRAINT "impact_affected_tables_impactItemId_fkey" FOREIGN KEY ("impactItemId") REFERENCES "impact_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "impact_affected_table_consumers" ADD CONSTRAINT "impact_affected_table_consumers_affectedTableId_fkey" FOREIGN KEY ("affectedTableId") REFERENCES "impact_affected_tables"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "impact_table_feedback" ADD CONSTRAINT "impact_table_feedback_impactItemId_fkey" FOREIGN KEY ("impactItemId") REFERENCES "impact_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Epic #208 (E6.1 / #230) — stakeholder + project-context model.
CREATE TABLE "stakeholders" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL DEFAULT '',
    "influence" TEXT NOT NULL DEFAULT 'medium',
    "interest" TEXT NOT NULL DEFAULT 'medium',
    "viewpoint" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stakeholders_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "project_contexts" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "businessGoals" TEXT NOT NULL DEFAULT '',
    "inScope" TEXT NOT NULL DEFAULT '[]',
    "outOfScope" TEXT NOT NULL DEFAULT '[]',
    "constraints" TEXT NOT NULL DEFAULT '[]',
    "glossary" TEXT NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_contexts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "requirement_stakeholders" (
    "id" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "stakeholderId" TEXT NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'should-have',
    "viewpoint" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "requirement_stakeholders_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "stakeholders_projectId_idx" ON "stakeholders"("projectId");
CREATE UNIQUE INDEX "stakeholders_projectId_name_key" ON "stakeholders"("projectId", "name");
CREATE UNIQUE INDEX "project_contexts_projectId_key" ON "project_contexts"("projectId");
CREATE INDEX "requirement_stakeholders_requirementId_idx" ON "requirement_stakeholders"("requirementId");
CREATE INDEX "requirement_stakeholders_stakeholderId_idx" ON "requirement_stakeholders"("stakeholderId");
CREATE UNIQUE INDEX "requirement_stakeholders_requirementId_stakeholderId_key" ON "requirement_stakeholders"("requirementId", "stakeholderId");

ALTER TABLE "stakeholders" ADD CONSTRAINT "stakeholders_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_contexts" ADD CONSTRAINT "project_contexts_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "requirement_stakeholders" ADD CONSTRAINT "requirement_stakeholders_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "requirements"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "requirement_stakeholders" ADD CONSTRAINT "requirement_stakeholders_stakeholderId_fkey" FOREIGN KEY ("stakeholderId") REFERENCES "stakeholders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Epic #47 — FinOps forecasting + alerting baseline tables (#48–#50).
ALTER TABLE "workspaces" ADD COLUMN "monthlyBudgetCents" INTEGER;

CREATE TABLE "cost_forecasts" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT,
    "scope" TEXT NOT NULL,
    "monthToDateCents" INTEGER NOT NULL DEFAULT 0,
    "projectedMonthEndCents" INTEGER NOT NULL DEFAULT 0,
    "dailyRunRateCents" INTEGER NOT NULL DEFAULT 0,
    "slopeCentsPerDay" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "ewmaCents" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sampleDays" INTEGER NOT NULL DEFAULT 0,
    "backtestMape" DOUBLE PRECISION,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cost_forecasts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "alert_rules" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "thresholdPct" INTEGER NOT NULL,
    "basis" TEXT NOT NULL DEFAULT 'projected',
    "cooldownSec" INTEGER NOT NULL DEFAULT 3600,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastFiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "alert_rules_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "alert_events" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "spendCents" INTEGER NOT NULL,
    "budgetCents" INTEGER NOT NULL,
    "ratio" DOUBLE PRECISION NOT NULL,
    "basis" TEXT NOT NULL,
    "deliveries" TEXT NOT NULL DEFAULT '[]',
    "firedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alert_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "alert_channels" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "secret" TEXT,
    "config" TEXT NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "alert_channels_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "cost_forecasts_workspaceId_scope_computedAt_idx" ON "cost_forecasts"("workspaceId", "scope", "computedAt");
CREATE INDEX "cost_forecasts_projectId_computedAt_idx" ON "cost_forecasts"("projectId", "computedAt");
CREATE INDEX "alert_rules_workspaceId_enabled_idx" ON "alert_rules"("workspaceId", "enabled");
CREATE INDEX "alert_events_workspaceId_firedAt_idx" ON "alert_events"("workspaceId", "firedAt");
CREATE INDEX "alert_events_ruleId_firedAt_idx" ON "alert_events"("ruleId", "firedAt");
CREATE INDEX "alert_channels_workspaceId_enabled_idx" ON "alert_channels"("workspaceId", "enabled");

ALTER TABLE "cost_forecasts" ADD CONSTRAINT "cost_forecasts_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "alert_events" ADD CONSTRAINT "alert_events_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "alert_events" ADD CONSTRAINT "alert_events_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "alert_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "alert_channels" ADD CONSTRAINT "alert_channels_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Epic #292 (#297) — schema usage classification
CREATE TABLE "schema_usage_classifications" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "tableName" TEXT NOT NULL,
    "columnName" TEXT,
    "columnType" TEXT,
    "usageClass" TEXT NOT NULL,
    "uncertainReason" TEXT,
    "evidence" TEXT NOT NULL DEFAULT '[]',
    "overriddenClass" TEXT,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "schema_usage_classifications_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "schema_usage_classifications_projectId_usageClass_idx" ON "schema_usage_classifications"("projectId", "usageClass");
CREATE INDEX "schema_usage_classifications_projectId_tableName_idx" ON "schema_usage_classifications"("projectId", "tableName");

ALTER TABLE "schema_usage_classifications" ADD CONSTRAINT "schema_usage_classifications_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Epic #294 (#304) — manual schema-usage override assertions.
CREATE TABLE "schema_usage_overrides" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "tableName" TEXT NOT NULL,
    "columnName" TEXT,
    "usageClass" TEXT NOT NULL,
    "access" TEXT NOT NULL DEFAULT 'reads',
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "schema_usage_overrides_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "schema_usage_overrides_projectId_idx" ON "schema_usage_overrides"("projectId");
CREATE UNIQUE INDEX "schema_usage_overrides_projectId_tableName_columnName_access_key" ON "schema_usage_overrides"("projectId", "tableName", "columnName", "access");

ALTER TABLE "schema_usage_overrides" ADD CONSTRAINT "schema_usage_overrides_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Epic #295 Phase 4 (#307) — workspace-scoped registry of physical databases.
CREATE TABLE "database_resources" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "driver" TEXT NOT NULL,
    "host" TEXT,
    "port" INTEGER,
    "databaseName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "database_resources_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "database_resources_workspaceId_idx" ON "database_resources"("workspaceId");
CREATE UNIQUE INDEX "database_resources_workspaceId_driver_host_port_databaseName_key" ON "database_resources"("workspaceId", "driver", "host", "port", "databaseName");

ALTER TABLE "database_resources" ADD CONSTRAINT "database_resources_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Epic #295 Phase 4 (#308) — canonical per-resource schema-object identity.
CREATE TABLE "schema_object_identities" (
    "id" TEXT NOT NULL,
    "databaseResourceId" TEXT NOT NULL,
    "schemaName" TEXT,
    "objectName" TEXT NOT NULL,
    "objectType" TEXT NOT NULL DEFAULT 'table',
    "usageClass" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "schema_object_identities_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "schema_object_identities_databaseResourceId_idx" ON "schema_object_identities"("databaseResourceId");
CREATE UNIQUE INDEX "schema_object_identities_databaseResourceId_schemaName_objectName_objectType_key" ON "schema_object_identities"("databaseResourceId", "schemaName", "objectName", "objectType");

ALTER TABLE "schema_object_identities" ADD CONSTRAINT "schema_object_identities_databaseResourceId_fkey" FOREIGN KEY ("databaseResourceId") REFERENCES "database_resources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Epic #404 (#413) — persistent refresh-token revocation.
CREATE TABLE "revoked_refresh_tokens" (
    "id" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "revoked_refresh_tokens_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "user_session_revocations" (
    "userId" TEXT NOT NULL,
    "cutoff" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_session_revocations_pkey" PRIMARY KEY ("userId")
);

CREATE UNIQUE INDEX "revoked_refresh_tokens_tokenId_key" ON "revoked_refresh_tokens"("tokenId");
CREATE INDEX "revoked_refresh_tokens_userId_idx" ON "revoked_refresh_tokens"("userId");
CREATE INDEX "revoked_refresh_tokens_expiresAt_idx" ON "revoked_refresh_tokens"("expiresAt");

-- Issue #416 — persisted in-app notifications.
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "href" TEXT,
    "payload" TEXT,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "notifications_userId_idx" ON "notifications"("userId");
CREATE INDEX "notifications_userId_read_idx" ON "notifications"("userId", "read");
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Epic #475 (Phase 1, #476) — collaborative multi-analyst discussion threads.
CREATE TABLE "discussion_threads" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "requirementId" TEXT,
    "analysisId" TEXT,
    "specKitFeatureId" TEXT,
    "title" TEXT NOT NULL DEFAULT 'New Discussion',
    "aiResponseMode" TEXT NOT NULL DEFAULT 'on_mention',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "discussion_threads_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "discussion_messages" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "authorKind" TEXT NOT NULL,
    "authorUserId" TEXT,
    "aiProvider" TEXT,
    "aiModel" TEXT,
    "aiSessionId" TEXT,
    "body" TEXT NOT NULL,
    "origin" TEXT NOT NULL DEFAULT 'metis',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "discussion_messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "discussion_threads_projectId_idx" ON "discussion_threads"("projectId");
CREATE INDEX "discussion_threads_requirementId_idx" ON "discussion_threads"("requirementId");
CREATE INDEX "discussion_threads_analysisId_idx" ON "discussion_threads"("analysisId");
CREATE INDEX "discussion_threads_specKitFeatureId_idx" ON "discussion_threads"("specKitFeatureId");
CREATE INDEX "discussion_messages_threadId_createdAt_idx" ON "discussion_messages"("threadId", "createdAt");

ALTER TABLE "discussion_threads" ADD CONSTRAINT "discussion_threads_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "discussion_threads" ADD CONSTRAINT "discussion_threads_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "requirements"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "discussion_threads" ADD CONSTRAINT "discussion_threads_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "analyses"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "discussion_threads" ADD CONSTRAINT "discussion_threads_specKitFeatureId_fkey" FOREIGN KEY ("specKitFeatureId") REFERENCES "spec_kit_features"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "discussion_threads" ADD CONSTRAINT "discussion_threads_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "discussion_messages" ADD CONSTRAINT "discussion_messages_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "discussion_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "discussion_messages" ADD CONSTRAINT "discussion_messages_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "discussion_messages" ADD CONSTRAINT "discussion_messages_aiSessionId_fkey" FOREIGN KEY ("aiSessionId") REFERENCES "ai_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Epic #547 Phase 0 (#548) — Teams app foundation (cumulative baseline append).
CREATE TABLE "teams_app_installations" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "appPasswordRef" TEXT NOT NULL,
    "tenantId" TEXT,
    "appType" TEXT NOT NULL DEFAULT 'MultiTenant',
    "status" TEXT NOT NULL DEFAULT 'active',
    "label" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "teams_app_installations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "teams_conversation_references" (
    "id" TEXT NOT NULL,
    "installationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "serviceUrl" TEXT NOT NULL,
    "tenantId" TEXT,
    "channelId" TEXT NOT NULL,
    "aadObjectId" TEXT,
    "userId" TEXT,
    "reference" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "teams_conversation_references_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "teams_app_installations_workspaceId_idx" ON "teams_app_installations"("workspaceId");
CREATE UNIQUE INDEX "teams_app_installations_workspaceId_appId_key" ON "teams_app_installations"("workspaceId", "appId");
CREATE INDEX "teams_conversation_references_installationId_idx" ON "teams_conversation_references"("installationId");
CREATE INDEX "teams_conversation_references_workspaceId_idx" ON "teams_conversation_references"("workspaceId");
CREATE UNIQUE INDEX "teams_conversation_references_workspaceId_conversationId_key" ON "teams_conversation_references"("workspaceId", "conversationId");

ALTER TABLE "teams_app_installations" ADD CONSTRAINT "teams_app_installations_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "teams_app_installations" ADD CONSTRAINT "teams_app_installations_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "teams_conversation_references" ADD CONSTRAINT "teams_conversation_references_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "teams_app_installations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Epic #547 Phase 1 (#549) — Teams thread↔channel link + AAD→METIS identity.
-- CreateTable
CREATE TABLE "teams_channel_links" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "tenantId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "teams_channel_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teams_user_identities" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "aadObjectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "email" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "teams_user_identities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "teams_channel_links_workspaceId_idx" ON "teams_channel_links"("workspaceId");
CREATE INDEX "teams_channel_links_projectId_idx" ON "teams_channel_links"("projectId");
CREATE UNIQUE INDEX "teams_channel_links_workspaceId_conversationId_key" ON "teams_channel_links"("workspaceId", "conversationId");
CREATE UNIQUE INDEX "teams_channel_links_threadId_key" ON "teams_channel_links"("threadId");
CREATE INDEX "teams_user_identities_workspaceId_idx" ON "teams_user_identities"("workspaceId");
CREATE INDEX "teams_user_identities_userId_idx" ON "teams_user_identities"("userId");
CREATE UNIQUE INDEX "teams_user_identities_tenantId_aadObjectId_key" ON "teams_user_identities"("tenantId", "aadObjectId");

-- AddForeignKey
ALTER TABLE "teams_channel_links" ADD CONSTRAINT "teams_channel_links_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "teams_channel_links" ADD CONSTRAINT "teams_channel_links_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "discussion_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "teams_channel_links" ADD CONSTRAINT "teams_channel_links_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "teams_user_identities" ADD CONSTRAINT "teams_user_identities_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "teams_user_identities" ADD CONSTRAINT "teams_user_identities_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable (Issue #67 — one-way Teams notification targets)
CREATE TABLE "teams_notification_targets" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "tenantId" TEXT,
    "reference" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "teams_notification_targets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "teams_notification_targets_workspaceId_idx" ON "teams_notification_targets"("workspaceId");
CREATE UNIQUE INDEX "teams_notification_targets_workspaceId_eventType_key" ON "teams_notification_targets"("workspaceId", "eventType");

-- AddForeignKey
ALTER TABLE "teams_notification_targets" ADD CONSTRAINT "teams_notification_targets_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "teams_notification_targets" ADD CONSTRAINT "teams_notification_targets_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable (Issue #580 — PagerDuty sev-1 service configs)
CREATE TABLE "pagerduty_service_configs" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "serviceKey" TEXT NOT NULL,
    "routingKeyRef" TEXT NOT NULL,
    "label" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pagerduty_service_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pagerduty_service_configs_workspaceId_idx" ON "pagerduty_service_configs"("workspaceId");
CREATE UNIQUE INDEX "pagerduty_service_configs_workspaceId_serviceKey_key" ON "pagerduty_service_configs"("workspaceId", "serviceKey");

-- AddForeignKey
ALTER TABLE "pagerduty_service_configs" ADD CONSTRAINT "pagerduty_service_configs_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pagerduty_service_configs" ADD CONSTRAINT "pagerduty_service_configs_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable (Issue #579 — Slack app installations)
CREATE TABLE "slack_app_installations" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "slackTeamId" TEXT NOT NULL,
    "slackTeamName" TEXT,
    "botUserId" TEXT,
    "botTokenRef" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "label" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "slack_app_installations_pkey" PRIMARY KEY ("id")
);

-- CreateTable (Issue #579 — Slack→METIS identity bindings)
CREATE TABLE "slack_user_identities" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "slackTeamId" TEXT NOT NULL,
    "slackUserId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "email" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "slack_user_identities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "slack_app_installations_workspaceId_idx" ON "slack_app_installations"("workspaceId");
CREATE INDEX "slack_app_installations_slackTeamId_idx" ON "slack_app_installations"("slackTeamId");
CREATE UNIQUE INDEX "slack_app_installations_workspaceId_slackTeamId_key" ON "slack_app_installations"("workspaceId", "slackTeamId");
CREATE INDEX "slack_user_identities_workspaceId_idx" ON "slack_user_identities"("workspaceId");
CREATE INDEX "slack_user_identities_userId_idx" ON "slack_user_identities"("userId");
CREATE UNIQUE INDEX "slack_user_identities_slackTeamId_slackUserId_key" ON "slack_user_identities"("slackTeamId", "slackUserId");

-- AddForeignKey
ALTER TABLE "slack_app_installations" ADD CONSTRAINT "slack_app_installations_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "slack_app_installations" ADD CONSTRAINT "slack_app_installations_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "slack_user_identities" ADD CONSTRAINT "slack_user_identities_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "slack_user_identities" ADD CONSTRAINT "slack_user_identities_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable (Issue #90 — versioned, diffable product API-contract docs)
CREATE TABLE "product_contract_docs" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "repoId" TEXT,
    "version" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "specIdentity" TEXT NOT NULL DEFAULT '[]',
    "itemsSnapshot" TEXT NOT NULL DEFAULT '[]',
    "diff" TEXT,
    "diffSummary" TEXT NOT NULL DEFAULT '',
    "content" TEXT NOT NULL DEFAULT '',
    "title" TEXT NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_contract_docs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_contract_docs_productId_idx" ON "product_contract_docs"("productId");
CREATE INDEX "product_contract_docs_productId_repoId_idx" ON "product_contract_docs"("productId", "repoId");
CREATE UNIQUE INDEX "product_contract_docs_productId_repoId_version_key" ON "product_contract_docs"("productId", "repoId", "version");

-- AddForeignKey
ALTER TABLE "product_contract_docs" ADD CONSTRAINT "product_contract_docs_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable (Issue #611 — per-user notification preferences, epic #608)
CREATE TABLE "notification_preferences" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notification_preferences_userId_idx" ON "notification_preferences"("userId");
CREATE UNIQUE INDEX "notification_preferences_userId_channel_event_key" ON "notification_preferences"("userId", "channel", "event");

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Issue #616 (epic #609) -- formal review & approval workflow + baselines.
-- CreateTable
CREATE TABLE "review_requests" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "policy" TEXT NOT NULL DEFAULT 'all',
    "quorum" INTEGER,
    "requestedById" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "review_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_request_items" (
    "id" TEXT NOT NULL,
    "reviewRequestId" TEXT NOT NULL,
    "requirementId" TEXT,
    "generatedDocumentId" TEXT,
    "pinnedVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_request_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reviewer_assignments" (
    "id" TEXT NOT NULL,
    "reviewRequestId" TEXT NOT NULL,
    "reviewerId" TEXT NOT NULL,
    "decision" TEXT NOT NULL DEFAULT 'pending',
    "note" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reviewer_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "baselines" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "reviewRequestId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "baselines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "baseline_items" (
    "id" TEXT NOT NULL,
    "baselineId" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "baseline_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "review_requests_projectId_status_idx" ON "review_requests"("projectId", "status");

-- CreateIndex
CREATE INDEX "review_requests_requestedById_idx" ON "review_requests"("requestedById");

-- CreateIndex
CREATE INDEX "review_request_items_requirementId_idx" ON "review_request_items"("requirementId");

-- CreateIndex
CREATE INDEX "review_request_items_generatedDocumentId_idx" ON "review_request_items"("generatedDocumentId");

-- CreateIndex
CREATE UNIQUE INDEX "review_request_items_reviewRequestId_requirementId_key" ON "review_request_items"("reviewRequestId", "requirementId");

-- CreateIndex
CREATE UNIQUE INDEX "review_request_items_reviewRequestId_generatedDocumentId_key" ON "review_request_items"("reviewRequestId", "generatedDocumentId");

-- CreateIndex
CREATE INDEX "reviewer_assignments_reviewerId_decision_idx" ON "reviewer_assignments"("reviewerId", "decision");

-- CreateIndex
CREATE UNIQUE INDEX "reviewer_assignments_reviewRequestId_reviewerId_key" ON "reviewer_assignments"("reviewRequestId", "reviewerId");

-- CreateIndex
CREATE UNIQUE INDEX "baselines_reviewRequestId_key" ON "baselines"("reviewRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "baselines_projectId_name_key" ON "baselines"("projectId", "name");

-- CreateIndex
CREATE INDEX "baseline_items_requirementId_idx" ON "baseline_items"("requirementId");

-- CreateIndex
CREATE UNIQUE INDEX "baseline_items_baselineId_requirementId_key" ON "baseline_items"("baselineId", "requirementId");

-- AddForeignKey
ALTER TABLE "review_requests" ADD CONSTRAINT "review_requests_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_requests" ADD CONSTRAINT "review_requests_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_request_items" ADD CONSTRAINT "review_request_items_reviewRequestId_fkey" FOREIGN KEY ("reviewRequestId") REFERENCES "review_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_request_items" ADD CONSTRAINT "review_request_items_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "requirements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_request_items" ADD CONSTRAINT "review_request_items_generatedDocumentId_fkey" FOREIGN KEY ("generatedDocumentId") REFERENCES "generated_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviewer_assignments" ADD CONSTRAINT "reviewer_assignments_reviewRequestId_fkey" FOREIGN KEY ("reviewRequestId") REFERENCES "review_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviewer_assignments" ADD CONSTRAINT "reviewer_assignments_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "baselines" ADD CONSTRAINT "baselines_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "baselines" ADD CONSTRAINT "baselines_reviewRequestId_fkey" FOREIGN KEY ("reviewRequestId") REFERENCES "review_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "baselines" ADD CONSTRAINT "baselines_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "baseline_items" ADD CONSTRAINT "baseline_items_baselineId_fkey" FOREIGN KEY ("baselineId") REFERENCES "baselines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "baseline_items" ADD CONSTRAINT "baseline_items_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "requirements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable (issue #623 -- typed cross-project requirement links)
CREATE TABLE "requirement_links" (
    "id" TEXT NOT NULL,
    "sourceRequirementId" TEXT NOT NULL,
    "targetRequirementId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "requirement_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "requirement_links_sourceRequirementId_idx" ON "requirement_links"("sourceRequirementId");

-- CreateIndex
CREATE INDEX "requirement_links_targetRequirementId_idx" ON "requirement_links"("targetRequirementId");

-- CreateIndex
CREATE UNIQUE INDEX "requirement_links_sourceRequirementId_targetRequirementId_type_key" ON "requirement_links"("sourceRequirementId", "targetRequirementId", "type");

-- AddForeignKey
ALTER TABLE "requirement_links" ADD CONSTRAINT "requirement_links_sourceRequirementId_fkey" FOREIGN KEY ("sourceRequirementId") REFERENCES "requirements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "requirement_links" ADD CONSTRAINT "requirement_links_targetRequirementId_fkey" FOREIGN KEY ("targetRequirementId") REFERENCES "requirements"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Epic #780 / Issue #797 — code-symbol embedding metadata (vector lives in
-- `rag_vectors` under the `<projectId>__symbols` namespace, not here).
-- CreateTable
CREATE TABLE "code_symbol_embeddings" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "codeGraphId" TEXT NOT NULL,
    "symbolId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "embeddingModel" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "code_symbol_embeddings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "code_symbol_embeddings_symbolId_key" ON "code_symbol_embeddings"("symbolId");

-- CreateIndex
CREATE INDEX "code_symbol_embeddings_projectId_embeddingModel_idx" ON "code_symbol_embeddings"("projectId", "embeddingModel");

-- CreateIndex
CREATE INDEX "code_symbol_embeddings_codeGraphId_idx" ON "code_symbol_embeddings"("codeGraphId");

-- AddForeignKey
ALTER TABLE "code_symbol_embeddings" ADD CONSTRAINT "code_symbol_embeddings_symbolId_fkey" FOREIGN KEY ("symbolId") REFERENCES "code_symbols"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "code_symbol_embeddings" ADD CONSTRAINT "code_symbol_embeddings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
