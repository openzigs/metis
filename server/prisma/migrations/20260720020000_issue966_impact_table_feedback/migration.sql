-- Issue #966 (Epic #960) — BA relevance feedback on affected tables, captured
-- for later harvest as labeled ground truth for the eval corpus.
--
-- `impact_table_feedback` holds ONE row per (impactItem, table, column, user)
-- verdict (`relevant` | `not-relevant`). `impactAnalysisId` is denormalized
-- (not a FK) purely for fast tenant-scoped listing, mirroring
-- `impact_affected_table_consumers.consumerProjectId`; the owning FK is
-- `impactItemId`. `userId`/`userDisplayName` are a snapshot (no FK to users),
-- mirroring `discussion_messages.authorUserId`.
--
-- v1 is CAPTURE + EXPORT ONLY: this table has ZERO behavioral effect on the
-- impact engine or the #936 LLM relevance filter.
CREATE TABLE "impact_table_feedback" (
    "id" TEXT NOT NULL,
    "impactAnalysisId" TEXT NOT NULL,
    "impactItemId" TEXT NOT NULL,
    "tableName" TEXT NOT NULL,
    "columnName" TEXT,
    "verdict" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "userDisplayName" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "impact_table_feedback_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "impact_table_feedback_impactItemId_fkey" FOREIGN KEY ("impactItemId") REFERENCES "impact_items"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "impact_table_feedback_impactItemId_tableName_columnName_userId_key" ON "impact_table_feedback"("impactItemId", "tableName", "columnName", "userId");

CREATE INDEX "impact_table_feedback_impactAnalysisId_idx" ON "impact_table_feedback"("impactAnalysisId");

CREATE INDEX "impact_table_feedback_impactItemId_idx" ON "impact_table_feedback"("impactItemId");
