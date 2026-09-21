-- Epic #192 — Closed Loop (v1.2.0).
--
-- Adds:
--   * Project.autoReviewPrs — opt-in flag for the AC-aware PR-reviewer agent
--     to run automatically on `pull_request.opened` events.
--   * Project.autoApproveSandbox — when true, the HIGH-risk `code_exec`
--     sandbox tool is auto-approved (otherwise it requires manual approval).
--   * Requirement.implementedAt — set by the living-spec webhook handler when
--     a PR linked to the originating issue is merged.
--   * Requirement.implementedByPr — PR number of the merging PR (for UI link).
--   * Requirement.implementedBySha — merge commit SHA (for traceability).
--   * requirement_implementations — per-PR file/line records powering the
--     "Implemented by" UI section on the requirement detail page.

ALTER TABLE "projects" ADD COLUMN "autoReviewPrs" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "projects" ADD COLUMN "autoApproveSandbox" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "requirements" ADD COLUMN "implementedAt" DATETIME;
ALTER TABLE "requirements" ADD COLUMN "implementedByPr" INTEGER;
ALTER TABLE "requirements" ADD COLUMN "implementedBySha" TEXT;

CREATE INDEX "requirements_implementedByPr_idx" ON "requirements"("implementedByPr");

CREATE TABLE "requirement_implementations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "requirementId" TEXT NOT NULL,
    "prNumber" INTEGER NOT NULL,
    "prUrl" TEXT NOT NULL,
    "commitSha" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "startLine" INTEGER,
    "endLine" INTEGER,
    "mergedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "requirement_implementations_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "requirements" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "requirement_implementations_requirementId_idx" ON "requirement_implementations"("requirementId");
CREATE INDEX "requirement_implementations_prNumber_idx" ON "requirement_implementations"("prNumber");
