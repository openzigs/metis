-- Issue #623 (epic #610) -- typed cross-project requirement links.
--
-- Adds `requirement_links`: a directional (source -> target) typed link between
-- two requirements, unique per (source, target, type). Both FKs cascade on
-- delete of the referenced requirement. `createdById` is a scalar soft-link to
-- users.id (no FK). ADDITIVE -- no existing table is altered -- so it is
-- non-destructive and trivially reversible (DROP the new table).

-- CreateTable
CREATE TABLE "requirement_links" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceRequirementId" TEXT NOT NULL,
    "targetRequirementId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "requirement_links_sourceRequirementId_fkey" FOREIGN KEY ("sourceRequirementId") REFERENCES "requirements" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "requirement_links_targetRequirementId_fkey" FOREIGN KEY ("targetRequirementId") REFERENCES "requirements" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "requirement_links_sourceRequirementId_idx" ON "requirement_links"("sourceRequirementId");

-- CreateIndex
CREATE INDEX "requirement_links_targetRequirementId_idx" ON "requirement_links"("targetRequirementId");

-- CreateIndex
CREATE UNIQUE INDEX "requirement_links_sourceRequirementId_targetRequirementId_type_key" ON "requirement_links"("sourceRequirementId", "targetRequirementId", "type");
