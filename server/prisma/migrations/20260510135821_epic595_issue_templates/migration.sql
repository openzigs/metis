-- CreateTable
CREATE TABLE "issue_templates" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'universal',
    "templateType" TEXT NOT NULL DEFAULT 'feature',
    "schema" TEXT NOT NULL,
    "defaultValues" TEXT NOT NULL DEFAULT '{}',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "issue_templates_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "issue_templates_projectId_platform_idx" ON "issue_templates"("projectId", "platform");

-- CreateIndex
CREATE INDEX "issue_templates_projectId_templateType_idx" ON "issue_templates"("projectId", "templateType");
