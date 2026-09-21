-- Epic #475 (Phase 1, #476) — Collaborative multi-analyst discussions.
--
-- Adds the `discussion_threads` + `discussion_messages` tables: a shared,
-- project-scoped realtime room where multiple analysts and the LLM collaborate.
-- Purpose-built rather than extending single-user `ai_sessions` or reusing
-- `comments` (whose `authorId` is a non-null FK to users and so cannot attribute
-- a message to the AI).
--
-- The migration is ADDITIVE — no existing table is altered — so it is
-- non-destructive and trivially reversible
-- (DROP TABLE discussion_messages; DROP TABLE discussion_threads).
--
-- Anchor columns (requirementId/analysisId/specKitFeatureId) are nullable so
-- thread anchoring is a non-breaking add (UI lands in Phase 4). `aiResponseMode`
-- is a String enum (off|on_mention|auto, default on_mention) — the epic's
-- confirmed product decision, superseding the earlier binary aiAutoRespond flag.

-- CreateTable
CREATE TABLE "discussion_threads" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "requirementId" TEXT,
    "analysisId" TEXT,
    "specKitFeatureId" TEXT,
    "title" TEXT NOT NULL DEFAULT 'New Discussion',
    "aiResponseMode" TEXT NOT NULL DEFAULT 'on_mention',
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "discussion_threads_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "discussion_threads_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "requirements" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "discussion_threads_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "analyses" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "discussion_threads_specKitFeatureId_fkey" FOREIGN KEY ("specKitFeatureId") REFERENCES "spec_kit_features" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "discussion_threads_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "discussion_messages" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "threadId" TEXT NOT NULL,
    "authorKind" TEXT NOT NULL,
    "authorUserId" TEXT,
    "aiProvider" TEXT,
    "aiModel" TEXT,
    "aiSessionId" TEXT,
    "body" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editedAt" DATETIME,
    "deletedAt" DATETIME,
    CONSTRAINT "discussion_messages_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "discussion_threads" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "discussion_messages_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "discussion_messages_aiSessionId_fkey" FOREIGN KEY ("aiSessionId") REFERENCES "ai_sessions" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "discussion_threads_projectId_idx" ON "discussion_threads"("projectId");

-- CreateIndex
CREATE INDEX "discussion_threads_requirementId_idx" ON "discussion_threads"("requirementId");

-- CreateIndex
CREATE INDEX "discussion_threads_analysisId_idx" ON "discussion_threads"("analysisId");

-- CreateIndex
CREATE INDEX "discussion_threads_specKitFeatureId_idx" ON "discussion_threads"("specKitFeatureId");

-- CreateIndex
CREATE INDEX "discussion_messages_threadId_createdAt_idx" ON "discussion_messages"("threadId", "createdAt");
