-- Epic #394 — PR-Review MVP (v1.2.x).
--
-- Adds three nullable columns on `projects` to back the PR-reviewer agent:
--
--   * Project.prReviewMaxDiffBytes — per-project override for the max diff
--     size (in bytes) the agent will send to the judge LLM. Diffs larger
--     than this are skipped with audit reason `diff_too_large`. Null falls
--     back to PR_REVIEW_MAX_DIFF_BYTES env (default 1_048_576 / 1 MiB).
--
--   * Project.prReviewSkipGlobs — per-project override for the JSON array
--     of glob patterns stripped from the diff before LLM input (lockfiles,
--     build outputs, snapshots). Null falls back to the built-in defaults.
--
--   * Project.prReviewMonthlyBudgetCents — per-project monthly cost cap
--     (integer cents) for PR-reviewer LLM spend. Null = no cap. Spend is
--     computed on-read from `TokenUsage.costCents` tagged with sessionId
--     starting `pr-review-` for the current UTC calendar month.

ALTER TABLE "projects" ADD COLUMN "prReviewMaxDiffBytes" INTEGER;
ALTER TABLE "projects" ADD COLUMN "prReviewSkipGlobs" TEXT;
ALTER TABLE "projects" ADD COLUMN "prReviewMonthlyBudgetCents" INTEGER;
