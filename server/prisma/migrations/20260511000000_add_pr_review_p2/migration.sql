-- Epic #394 P2 (#403/#404/#405) — PR-Review state + webhook delivery dedup.
--
-- Adds two new tables backing the P2 PR-reviewer features:
--
--   * pr_review_state — one row per (projectId, repo, prNumber) tracking
--     the last reviewed HEAD SHA, per-AC verdict carry-forward JSON, and a
--     pointer back to the AgentRun row so the UI can deep-link to the
--     review detail view (#404). Drives the incremental re-review path
--     (#405) — when a synchronize event arrives we diff lastReviewedSha..HEAD
--     and only re-judge ACs whose evidence files appear in the new diff.
--
--   * pr_review_webhook_deliveries — dedup table keyed on
--     `X-GitHub-Delivery`. The async queue producer (#403) inserts a row
--     under a unique constraint, so duplicate webhook deliveries (GitHub
--     retries on transient errors) short-circuit instead of enqueueing the
--     same review twice.

CREATE TABLE "pr_review_state" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "projectId" TEXT NOT NULL,
  "repoOwner" TEXT NOT NULL,
  "repoName" TEXT NOT NULL,
  "prNumber" INTEGER NOT NULL,
  "lastReviewedSha" TEXT,
  "acVerdictsJson" TEXT NOT NULL DEFAULT '[]',
  "lastRunId" TEXT,
  "lastVerdict" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "pr_review_state_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "pr_review_state_projectId_repoOwner_repoName_prNumber_key"
  ON "pr_review_state" ("projectId", "repoOwner", "repoName", "prNumber");
CREATE INDEX "pr_review_state_projectId_updatedAt_idx"
  ON "pr_review_state" ("projectId", "updatedAt");

CREATE TABLE "pr_review_webhook_deliveries" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "deliveryId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "runId" TEXT
);
CREATE UNIQUE INDEX "pr_review_webhook_deliveries_deliveryId_key"
  ON "pr_review_webhook_deliveries" ("deliveryId");
CREATE INDEX "pr_review_webhook_deliveries_receivedAt_idx"
  ON "pr_review_webhook_deliveries" ("receivedAt");
