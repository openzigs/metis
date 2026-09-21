-- Epic #193 — Spec Kit Mode (v1.2.0).
--
-- Adds:
--   * Project.specKitEnabled — opt-in flag for the Spec Kit workflow.
--   * SpecKitArtifact — DB-backed snapshot of every `.specify/<name>` file
--     for projects without an attached working repo. The DB row is the
--     authoritative store for v1.2; a future iteration may also write the
--     same content to the project's working repo if one is configured.

ALTER TABLE "projects" ADD COLUMN "specKitEnabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "spec_kit_artifacts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "spec_kit_artifacts_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "spec_kit_artifacts_projectId_name_key" ON "spec_kit_artifacts"("projectId", "name");
CREATE INDEX "spec_kit_artifacts_projectId_idx" ON "spec_kit_artifacts"("projectId");
