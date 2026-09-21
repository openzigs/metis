-- Epic #176 / #179 — allow IssueLink to reference an analysis Finding as well
-- as a scanner ScanFinding. Exactly one of scanFindingId / findingId is set.

-- AlterTable
ALTER TABLE "scanner_issue_links" ALTER COLUMN "scanFindingId" DROP NOT NULL;
ALTER TABLE "scanner_issue_links" ADD COLUMN IF NOT EXISTS "findingId" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "scanner_issue_links_findingId_idx" ON "scanner_issue_links"("findingId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "scanner_issue_links_findingId_provider_key" ON "scanner_issue_links"("findingId", "provider");

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scanner_issue_links_findingId_fkey') THEN
    EXECUTE 'ALTER TABLE "scanner_issue_links" ADD CONSTRAINT "scanner_issue_links_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "findings"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END
$idem$;
