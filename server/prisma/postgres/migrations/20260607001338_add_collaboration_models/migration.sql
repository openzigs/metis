-- Epic #728: Multi-User Collaboration on Requirements & Specs.
-- Adds optimistic-locking version field to requirements, plus
-- comment_threads, comments, mentions, and assignments tables.

-- Optimistic-locking version counter on requirements.
ALTER TABLE "requirements" ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 0;

-- Polymorphic comment thread.
CREATE TABLE IF NOT EXISTS "comment_threads" (
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

DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'comment_threads_requirementId_fkey') THEN
    EXECUTE 'ALTER TABLE "comment_threads" ADD CONSTRAINT "comment_threads_requirementId_fkey"
    FOREIGN KEY ("requirementId") REFERENCES "requirements"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END
$idem$;

CREATE INDEX IF NOT EXISTS "comment_threads_requirementId_idx" ON "comment_threads"("requirementId");
CREATE INDEX IF NOT EXISTS "comment_threads_specKitProjectId_specKitArtifactName_idx"
    ON "comment_threads"("specKitProjectId", "specKitArtifactName");

-- Individual comment in a thread.
CREATE TABLE IF NOT EXISTS "comments" (
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

DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'comments_threadId_fkey') THEN
    EXECUTE 'ALTER TABLE "comments" ADD CONSTRAINT "comments_threadId_fkey"
    FOREIGN KEY ("threadId") REFERENCES "comment_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END
$idem$;
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'comments_authorId_fkey') THEN
    EXECUTE 'ALTER TABLE "comments" ADD CONSTRAINT "comments_authorId_fkey"
    FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END
$idem$;

CREATE INDEX IF NOT EXISTS "comments_threadId_idx" ON "comments"("threadId");
CREATE INDEX IF NOT EXISTS "comments_authorId_idx" ON "comments"("authorId");

-- @mention inside a comment.
CREATE TABLE IF NOT EXISTS "mentions" (
    "id" TEXT NOT NULL,
    "commentId" TEXT NOT NULL,
    "mentionedUserId" TEXT NOT NULL,
    "notified" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mentions_pkey" PRIMARY KEY ("id")
);

DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mentions_commentId_fkey') THEN
    EXECUTE 'ALTER TABLE "mentions" ADD CONSTRAINT "mentions_commentId_fkey"
    FOREIGN KEY ("commentId") REFERENCES "comments"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END
$idem$;
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mentions_mentionedUserId_fkey') THEN
    EXECUTE 'ALTER TABLE "mentions" ADD CONSTRAINT "mentions_mentionedUserId_fkey"
    FOREIGN KEY ("mentionedUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END
$idem$;

CREATE UNIQUE INDEX IF NOT EXISTS "mentions_commentId_mentionedUserId_key" ON "mentions"("commentId", "mentionedUserId");
CREATE INDEX IF NOT EXISTS "mentions_mentionedUserId_idx" ON "mentions"("mentionedUserId");

-- Requirement assignment with optional SLA deadline.
CREATE TABLE IF NOT EXISTS "assignments" (
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

DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'assignments_requirementId_fkey') THEN
    EXECUTE 'ALTER TABLE "assignments" ADD CONSTRAINT "assignments_requirementId_fkey"
    FOREIGN KEY ("requirementId") REFERENCES "requirements"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END
$idem$;
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'assignments_assigneeId_fkey') THEN
    EXECUTE 'ALTER TABLE "assignments" ADD CONSTRAINT "assignments_assigneeId_fkey"
    FOREIGN KEY ("assigneeId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END
$idem$;
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'assignments_assignedById_fkey') THEN
    EXECUTE 'ALTER TABLE "assignments" ADD CONSTRAINT "assignments_assignedById_fkey"
    FOREIGN KEY ("assignedById") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END
$idem$;

CREATE UNIQUE INDEX IF NOT EXISTS "assignments_requirementId_assigneeId_key" ON "assignments"("requirementId", "assigneeId");
CREATE INDEX IF NOT EXISTS "assignments_requirementId_idx" ON "assignments"("requirementId");
CREATE INDEX IF NOT EXISTS "assignments_assigneeId_idx" ON "assignments"("assigneeId");
