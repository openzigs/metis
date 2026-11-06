-- Issue #1838 (epic #1828) — "Not a duplicate" answers to the similar-
-- requirements duplicate warning. Postgres twin of
-- server/prisma/migrations/20261114001838_issue1838_requirement_similarity_dismissals;
-- see that file for the rationale. One new table, one row per unordered pair,
-- both ids cascading with their requirements.
--
-- Structural DDL is idempotent (#556), so the full history applies from empty.
--
-- Rollback: server/prisma/postgres/rollbacks/20261114001838_issue1838_requirement_similarity_dismissals.sql

-- CreateTable
CREATE TABLE IF NOT EXISTS "requirement_similarity_dismissals" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "otherRequirementId" TEXT NOT NULL,
    "dismissedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "requirement_similarity_dismissals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "requirement_similarity_dismissals_pair_key" ON "requirement_similarity_dismissals"("requirementId", "otherRequirementId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "requirement_similarity_dismissals_otherRequirementId_idx" ON "requirement_similarity_dismissals"("otherRequirementId");

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'requirement_similarity_dismissals_requirementId_fkey') THEN
    EXECUTE 'ALTER TABLE "requirement_similarity_dismissals" ADD CONSTRAINT "requirement_similarity_dismissals_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "requirements"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'requirement_similarity_dismissals_otherRequirementId_fkey') THEN
    EXECUTE 'ALTER TABLE "requirement_similarity_dismissals" ADD CONSTRAINT "requirement_similarity_dismissals_otherRequirementId_fkey" FOREIGN KEY ("otherRequirementId") REFERENCES "requirements"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END
$idem$;
