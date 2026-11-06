-- Issue #1838 (epic #1828) — "Not a duplicate" answers to the similar-
-- requirements duplicate warning.
--
--   requirement_similarity_dismissals  one row per unordered pair an analyst
--                   said is not a duplicate: `requirementId` is the lower of
--                   the two ids, `otherRequirementId` the higher, so one row
--                   answers for both cards. Read by the similar-requirements
--                   API, which reports the pair as `notDuplicate` so a reload
--                   does not raise the warning again.
--
-- Both ids cascade: an analysis re-run deletes and recreates its requirements,
-- and the answer goes with the requirements it was about. A new, empty table.
--
-- Rollback: server/prisma/rollbacks/20261114001838_issue1838_requirement_similarity_dismissals.sql
-- (exercised by server/tests/requirement-similarity-dismissal-migration-1838.sqlite.test.ts).

-- CreateTable
CREATE TABLE "requirement_similarity_dismissals" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "otherRequirementId" TEXT NOT NULL,
    "dismissedById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "requirement_similarity_dismissals_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "requirements" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "requirement_similarity_dismissals_otherRequirementId_fkey" FOREIGN KEY ("otherRequirementId") REFERENCES "requirements" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "requirement_similarity_dismissals_pair_key" ON "requirement_similarity_dismissals"("requirementId", "otherRequirementId");

-- CreateIndex
CREATE INDEX "requirement_similarity_dismissals_otherRequirementId_idx" ON "requirement_similarity_dismissals"("otherRequirementId");
