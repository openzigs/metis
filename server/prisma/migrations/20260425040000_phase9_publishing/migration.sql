-- Phase 9 — Publishing extensions
-- Adds parent/dedup/draftType columns to issue_drafts; dry-run/archive
-- counters/targetBaseUrl to publish_batches; parent/dedup hashes to
-- published_issues.

-- IssueDraft -----------------------------------------------------------------
ALTER TABLE "issue_drafts" ADD COLUMN "parentDraftId" TEXT;
ALTER TABLE "issue_drafts" ADD COLUMN "draftType" TEXT NOT NULL DEFAULT 'feature';
ALTER TABLE "issue_drafts" ADD COLUMN "dedupHash" TEXT;
ALTER TABLE "issue_drafts" ADD COLUMN "metadata" TEXT;

CREATE INDEX "issue_drafts_parentDraftId_idx" ON "issue_drafts"("parentDraftId");
CREATE INDEX "issue_drafts_dedupHash_idx" ON "issue_drafts"("dedupHash");

-- PublishBatch ---------------------------------------------------------------
ALTER TABLE "publish_batches" ADD COLUMN "targetBaseUrl" TEXT;
ALTER TABLE "publish_batches" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'github';
ALTER TABLE "publish_batches" ADD COLUMN "dryRun" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "publish_batches" ADD COLUMN "totalDrafts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "publish_batches" ADD COLUMN "publishedCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "publish_batches" ADD COLUMN "failedCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "publish_batches" ADD COLUMN "dedupSkipped" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "publish_batches" ADD COLUMN "archived" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "publish_batches" ADD COLUMN "archivedAt" DATETIME;
ALTER TABLE "publish_batches" ADD COLUMN "archiveReason" TEXT;
ALTER TABLE "publish_batches" ADD COLUMN "archivedById" TEXT;
ALTER TABLE "publish_batches" ADD COLUMN "dryRunPlan" TEXT;

CREATE INDEX "publish_batches_archived_idx" ON "publish_batches"("archived");

-- PublishedIssue -------------------------------------------------------------
ALTER TABLE "published_issues" ADD COLUMN "parentIssueNumber" INTEGER;
ALTER TABLE "published_issues" ADD COLUMN "dedupHash" TEXT;
ALTER TABLE "published_issues" ADD COLUMN "bodyHash" TEXT;

CREATE INDEX "published_issues_dedupHash_idx" ON "published_issues"("dedupHash");
