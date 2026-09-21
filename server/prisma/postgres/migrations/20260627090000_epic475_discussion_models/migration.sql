-- Epic #475 (Phase 1, #476) — Collaborative multi-analyst discussions.
-- Postgres mirror of the SQLite migration.
--
-- Adds the `discussion_threads` + `discussion_messages` tables. ADDITIVE — no
-- existing table is altered — so it is non-destructive and trivially reversible.
-- Anchor columns are nullable; `aiResponseMode` is a String enum
-- (off|on_mention|auto, default on_mention).

-- CreateTable
CREATE TABLE IF NOT EXISTS "discussion_threads" (
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

-- CreateTable
CREATE TABLE IF NOT EXISTS "discussion_messages" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "authorKind" TEXT NOT NULL,
    "authorUserId" TEXT,
    "aiProvider" TEXT,
    "aiModel" TEXT,
    "aiSessionId" TEXT,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "discussion_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "discussion_threads_projectId_idx" ON "discussion_threads"("projectId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "discussion_threads_requirementId_idx" ON "discussion_threads"("requirementId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "discussion_threads_analysisId_idx" ON "discussion_threads"("analysisId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "discussion_threads_specKitFeatureId_idx" ON "discussion_threads"("specKitFeatureId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "discussion_messages_threadId_createdAt_idx" ON "discussion_messages"("threadId", "createdAt");

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'discussion_threads_projectId_fkey') THEN
    EXECUTE 'ALTER TABLE "discussion_threads" ADD CONSTRAINT "discussion_threads_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END
$idem$;

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'discussion_threads_requirementId_fkey') THEN
    EXECUTE 'ALTER TABLE "discussion_threads" ADD CONSTRAINT "discussion_threads_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "requirements"("id") ON DELETE SET NULL ON UPDATE CASCADE';
  END IF;
END
$idem$;

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'discussion_threads_analysisId_fkey') THEN
    EXECUTE 'ALTER TABLE "discussion_threads" ADD CONSTRAINT "discussion_threads_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "analyses"("id") ON DELETE SET NULL ON UPDATE CASCADE';
  END IF;
END
$idem$;

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'discussion_threads_specKitFeatureId_fkey') THEN
    EXECUTE 'ALTER TABLE "discussion_threads" ADD CONSTRAINT "discussion_threads_specKitFeatureId_fkey" FOREIGN KEY ("specKitFeatureId") REFERENCES "spec_kit_features"("id") ON DELETE SET NULL ON UPDATE CASCADE';
  END IF;
END
$idem$;

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'discussion_threads_createdById_fkey') THEN
    EXECUTE 'ALTER TABLE "discussion_threads" ADD CONSTRAINT "discussion_threads_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE';
  END IF;
END
$idem$;

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'discussion_messages_threadId_fkey') THEN
    EXECUTE 'ALTER TABLE "discussion_messages" ADD CONSTRAINT "discussion_messages_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "discussion_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END
$idem$;

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'discussion_messages_authorUserId_fkey') THEN
    EXECUTE 'ALTER TABLE "discussion_messages" ADD CONSTRAINT "discussion_messages_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE';
  END IF;
END
$idem$;

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'discussion_messages_aiSessionId_fkey') THEN
    EXECUTE 'ALTER TABLE "discussion_messages" ADD CONSTRAINT "discussion_messages_aiSessionId_fkey" FOREIGN KEY ("aiSessionId") REFERENCES "ai_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE';
  END IF;
END
$idem$;
