-- Issue #1830 (epic #1827) — stamp each requirement→code citation with the
-- code-graph version it was read from (Postgres twin of
-- server/prisma/migrations/20261113001830_issue1830_code_citation_freshness;
-- see that file for the columns). Every existing row reads
-- `freshness = 'unverified'` and null in every other new column; nothing is
-- backfilled.
--
-- Structural DDL is idempotent (#556), so the full history applies from empty.
--
-- Rollback: server/prisma/postgres/rollbacks/20261113001830_issue1830_code_citation_freshness.sql

-- AlterTable
ALTER TABLE "requirement_code_mappings" ADD COLUMN IF NOT EXISTS "codeGraphId" TEXT,
ADD COLUMN IF NOT EXISTS "commitSha" TEXT,
ADD COLUMN IF NOT EXISTS "freshness" TEXT NOT NULL DEFAULT 'unverified',
ADD COLUMN IF NOT EXISTS "validatedAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "previousFilePath" TEXT,
ADD COLUMN IF NOT EXISTS "previousStartLine" INTEGER,
ADD COLUMN IF NOT EXISTS "previousEndLine" INTEGER,
ADD COLUMN IF NOT EXISTS "staleReason" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "requirement_code_mappings_codeGraphId_idx" ON "requirement_code_mappings"("codeGraphId");

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'requirement_code_mappings_codeGraphId_fkey') THEN
    EXECUTE 'ALTER TABLE "requirement_code_mappings" ADD CONSTRAINT "requirement_code_mappings_codeGraphId_fkey" FOREIGN KEY ("codeGraphId") REFERENCES "code_graphs"("id") ON DELETE SET NULL ON UPDATE CASCADE';
  END IF;
END
$idem$;
