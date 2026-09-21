-- CreateTable
CREATE TABLE "stakeholders" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL DEFAULT '',
    "influence" TEXT NOT NULL DEFAULT 'medium',
    "interest" TEXT NOT NULL DEFAULT 'medium',
    "viewpoint" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "stakeholders_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "project_contexts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "businessGoals" TEXT NOT NULL DEFAULT '',
    "inScope" TEXT NOT NULL DEFAULT '[]',
    "outOfScope" TEXT NOT NULL DEFAULT '[]',
    "constraints" TEXT NOT NULL DEFAULT '[]',
    "glossary" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "project_contexts_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "requirement_stakeholders" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "requirementId" TEXT NOT NULL,
    "stakeholderId" TEXT NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'should-have',
    "viewpoint" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "requirement_stakeholders_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "requirements" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "requirement_stakeholders_stakeholderId_fkey" FOREIGN KEY ("stakeholderId") REFERENCES "stakeholders" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "stakeholders_projectId_idx" ON "stakeholders"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "stakeholders_projectId_name_key" ON "stakeholders"("projectId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "project_contexts_projectId_key" ON "project_contexts"("projectId");

-- CreateIndex
CREATE INDEX "requirement_stakeholders_requirementId_idx" ON "requirement_stakeholders"("requirementId");

-- CreateIndex
CREATE INDEX "requirement_stakeholders_stakeholderId_idx" ON "requirement_stakeholders"("stakeholderId");

-- CreateIndex
CREATE UNIQUE INDEX "requirement_stakeholders_requirementId_stakeholderId_key" ON "requirement_stakeholders"("requirementId", "stakeholderId");
