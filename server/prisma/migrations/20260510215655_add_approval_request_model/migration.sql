-- CreateTable
CREATE TABLE "approval_requests" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "analysisId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reviewerId" TEXT,
    "reviewNote" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" DATETIME,
    CONSTRAINT "approval_requests_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "analyses" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "approval_requests_analysisId_status_idx" ON "approval_requests"("analysisId", "status");

-- CreateIndex
CREATE INDEX "approval_requests_status_idx" ON "approval_requests"("status");
