-- DropIndex
DROP INDEX IF EXISTS "published_issues_batchId_draftId_key";

-- DropIndex
DROP INDEX IF EXISTS "published_issues_batchId_issueNumber_key";

-- CreateIndex
CREATE UNIQUE INDEX "published_issues_batchId_draftId_destination_key" ON "published_issues"("batchId", "draftId", "destination");

-- CreateIndex (non-unique — Jira rows all use issueNumber=0, so a unique constraint is incompatible with multi-draft Jira batches)
CREATE INDEX "published_issues_batchId_issueNumber_destination_idx" ON "published_issues"("batchId", "issueNumber", "destination");
