-- CreateTable
CREATE TABLE "cross_doc_findings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "analysisId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'medium',
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "evidenceIds" TEXT NOT NULL DEFAULT '[]',
    "scope" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "cross_doc_findings_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "analyses" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "cross_doc_findings_analysisId_idx" ON "cross_doc_findings"("analysisId");

-- CreateIndex
CREATE INDEX "cross_doc_findings_kind_idx" ON "cross_doc_findings"("kind");
