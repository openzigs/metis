-- Epic #770: Requirement Version History & Per-Row Audit Trail.
-- Append-only requirement_versions table storing compact per-edit diffs.

-- CreateTable
CREATE TABLE "requirement_versions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "requirementId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "changedFields" TEXT NOT NULL,
    "actorId" TEXT,
    "reason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "requirement_versions_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "requirements" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "requirement_versions_requirementId_idx" ON "requirement_versions"("requirementId");

-- CreateIndex
CREATE INDEX "requirement_versions_actorId_idx" ON "requirement_versions"("actorId");

-- CreateIndex
CREATE UNIQUE INDEX "requirement_versions_requirementId_version_key" ON "requirement_versions"("requirementId", "version");
