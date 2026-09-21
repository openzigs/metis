-- CreateTable
CREATE TABLE "comment_threads" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "requirementId" TEXT,
    "specKitProjectId" TEXT,
    "specKitArtifactName" TEXT,
    "title" TEXT,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "comment_threads_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "requirements" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "comments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "threadId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "editedAt" DATETIME,
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "comments_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "comment_threads" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "comments_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "mentions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "commentId" TEXT NOT NULL,
    "mentionedUserId" TEXT NOT NULL,
    "notified" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "mentions_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "comments" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "mentions_mentionedUserId_fkey" FOREIGN KEY ("mentionedUserId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "assignments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "requirementId" TEXT NOT NULL,
    "assigneeId" TEXT NOT NULL,
    "assignedById" TEXT NOT NULL,
    "slaDeadline" DATETIME,
    "resolvedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "assignments_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "requirements" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "assignments_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "assignments_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_requirements" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'feature',
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'medium',
    "labels" TEXT NOT NULL DEFAULT '[]',
    "reviewStatus" TEXT,
    "storyPoints" INTEGER,
    "parentId" TEXT,
    "implementedAt" DATETIME,
    "implementedByPr" INTEGER,
    "implementedBySha" TEXT,
    "externalSource" TEXT,
    "externalId" TEXT,
    "externalUrl" TEXT,
    "importSourceId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "requirements_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "requirements_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "analyses" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "requirements_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "requirements" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_requirements" ("analysisId", "body", "createdAt", "deletedAt", "externalId", "externalSource", "externalUrl", "id", "implementedAt", "implementedByPr", "implementedBySha", "importSourceId", "labels", "parentId", "priority", "projectId", "reviewStatus", "storyPoints", "title", "type", "updatedAt") SELECT "analysisId", "body", "createdAt", "deletedAt", "externalId", "externalSource", "externalUrl", "id", "implementedAt", "implementedByPr", "implementedBySha", "importSourceId", "labels", "parentId", "priority", "projectId", "reviewStatus", "storyPoints", "title", "type", "updatedAt" FROM "requirements";
DROP TABLE "requirements";
ALTER TABLE "new_requirements" RENAME TO "requirements";
CREATE INDEX "requirements_projectId_idx" ON "requirements"("projectId");
CREATE INDEX "requirements_analysisId_idx" ON "requirements"("analysisId");
CREATE INDEX "requirements_parentId_idx" ON "requirements"("parentId");
CREATE INDEX "requirements_implementedByPr_idx" ON "requirements"("implementedByPr");
CREATE INDEX "requirements_importSourceId_idx" ON "requirements"("importSourceId");
CREATE UNIQUE INDEX "requirements_projectId_externalSource_externalId_key" ON "requirements"("projectId", "externalSource", "externalId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "comment_threads_requirementId_idx" ON "comment_threads"("requirementId");

-- CreateIndex
CREATE INDEX "comment_threads_specKitProjectId_specKitArtifactName_idx" ON "comment_threads"("specKitProjectId", "specKitArtifactName");

-- CreateIndex
CREATE INDEX "comments_threadId_idx" ON "comments"("threadId");

-- CreateIndex
CREATE INDEX "comments_authorId_idx" ON "comments"("authorId");

-- CreateIndex
CREATE INDEX "mentions_mentionedUserId_idx" ON "mentions"("mentionedUserId");

-- CreateIndex
CREATE UNIQUE INDEX "mentions_commentId_mentionedUserId_key" ON "mentions"("commentId", "mentionedUserId");

-- CreateIndex
CREATE INDEX "assignments_requirementId_idx" ON "assignments"("requirementId");

-- CreateIndex
CREATE INDEX "assignments_assigneeId_idx" ON "assignments"("assigneeId");

-- CreateIndex
CREATE UNIQUE INDEX "assignments_requirementId_assigneeId_key" ON "assignments"("requirementId", "assigneeId");
