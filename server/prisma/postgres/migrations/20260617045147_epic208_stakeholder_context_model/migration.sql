-- Epic #208 (E6.1 / #230): stakeholder + project-context model.
-- Three new models: stakeholders (power/interest + viewpoint), project_contexts
-- (one-per-project framing — goals/scope/constraints/glossary as JSON-as-TEXT),
-- and requirement_stakeholders (requirement ↔ stakeholder association with a
-- per-link priority + viewpoint).

-- CreateTable
CREATE TABLE IF NOT EXISTS "stakeholders" (
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

-- CreateTable
CREATE TABLE IF NOT EXISTS "project_contexts" (
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

-- CreateTable
CREATE TABLE IF NOT EXISTS "requirement_stakeholders" (
    "id" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "stakeholderId" TEXT NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'should-have',
    "viewpoint" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "requirement_stakeholders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "stakeholders_projectId_idx" ON "stakeholders"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "stakeholders_projectId_name_key" ON "stakeholders"("projectId", "name");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "project_contexts_projectId_key" ON "project_contexts"("projectId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "requirement_stakeholders_requirementId_idx" ON "requirement_stakeholders"("requirementId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "requirement_stakeholders_stakeholderId_idx" ON "requirement_stakeholders"("stakeholderId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "requirement_stakeholders_requirementId_stakeholderId_key" ON "requirement_stakeholders"("requirementId", "stakeholderId");

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stakeholders_projectId_fkey') THEN
    EXECUTE 'ALTER TABLE "stakeholders" ADD CONSTRAINT "stakeholders_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END
$idem$;

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_contexts_projectId_fkey') THEN
    EXECUTE 'ALTER TABLE "project_contexts" ADD CONSTRAINT "project_contexts_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END
$idem$;

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'requirement_stakeholders_requirementId_fkey') THEN
    EXECUTE 'ALTER TABLE "requirement_stakeholders" ADD CONSTRAINT "requirement_stakeholders_requirementId_fkey"
    FOREIGN KEY ("requirementId") REFERENCES "requirements"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END
$idem$;

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'requirement_stakeholders_stakeholderId_fkey') THEN
    EXECUTE 'ALTER TABLE "requirement_stakeholders" ADD CONSTRAINT "requirement_stakeholders_stakeholderId_fkey"
    FOREIGN KEY ("stakeholderId") REFERENCES "stakeholders"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END
$idem$;
