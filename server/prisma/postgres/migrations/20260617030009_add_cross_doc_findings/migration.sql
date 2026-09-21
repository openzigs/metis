-- Epic #203 (#221) — first-class cross-document conflict / contradiction /
-- completeness findings detected over the ingested customer documents.

-- CreateTable
CREATE TABLE IF NOT EXISTS "cross_doc_findings" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'medium',
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "evidenceIds" TEXT NOT NULL DEFAULT '[]',
    "scope" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cross_doc_findings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "cross_doc_findings_analysisId_idx" ON "cross_doc_findings"("analysisId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "cross_doc_findings_kind_idx" ON "cross_doc_findings"("kind");

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cross_doc_findings_analysisId_fkey') THEN
    EXECUTE 'ALTER TABLE "cross_doc_findings" ADD CONSTRAINT "cross_doc_findings_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "analyses"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END
$idem$;
