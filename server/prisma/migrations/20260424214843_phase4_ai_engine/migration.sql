-- CreateTable
CREATE TABLE "ai_sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "projectId" TEXT,
    "title" TEXT NOT NULL DEFAULT 'New Chat',
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "policy" TEXT NOT NULL DEFAULT '{"low":"auto","medium":"prompt-once","high":"always-prompt"}',
    "status" TEXT NOT NULL DEFAULT 'active',
    "providerSecretRef" TEXT,
    "copilotHome" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "ai_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ai_sessions_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ai_token_usages" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "dayBucket" TEXT NOT NULL,
    "ts" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ai_token_usages_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ai_sessions" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ai_token_usages_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ai_tool_approvals" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "risk" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "reason" TEXT,
    "argsHash" TEXT NOT NULL,
    "ts" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ai_tool_approvals_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ai_sessions" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ai_tool_approvals_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ai_sessions_userId_idx" ON "ai_sessions"("userId");

-- CreateIndex
CREATE INDEX "ai_sessions_projectId_idx" ON "ai_sessions"("projectId");

-- CreateIndex
CREATE INDEX "ai_sessions_status_idx" ON "ai_sessions"("status");

-- CreateIndex
CREATE INDEX "ai_token_usages_sessionId_ts_idx" ON "ai_token_usages"("sessionId", "ts");

-- CreateIndex
CREATE INDEX "ai_token_usages_userId_dayBucket_idx" ON "ai_token_usages"("userId", "dayBucket");

-- CreateIndex
CREATE INDEX "ai_token_usages_ts_idx" ON "ai_token_usages"("ts");

-- CreateIndex
CREATE INDEX "ai_tool_approvals_sessionId_ts_idx" ON "ai_tool_approvals"("sessionId", "ts");

-- CreateIndex
CREATE INDEX "ai_tool_approvals_toolName_idx" ON "ai_tool_approvals"("toolName");

-- CreateIndex
CREATE INDEX "ai_tool_approvals_userId_ts_idx" ON "ai_tool_approvals"("userId", "ts");
