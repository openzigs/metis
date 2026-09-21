/**
 * Epic #394 P2 review F4 — extracted PR-review job executor.
 *
 * Centralises the "resolve linked ACs → fetch diff → start AgentRun →
 * runPrReview → record result" pipeline that the webhook handler used to
 * inline. Exporting it as a single function lets BOTH the inline path
 * AND the worker queue's processor share the same code path so the
 * production worker actually performs the review (instead of just
 * logging that it was unconfigured).
 *
 * Test seam: `deps.judge` and `deps.octokit` are required arguments —
 * callers (the webhook handler and the worker bootstrap) decide how to
 * resolve them. When omitted (legacy webhook path with no injection),
 * the function returns `{ skipped: "no_judge_or_octokit" }` so the
 * caller can log a structured warning instead of silently dropping the
 * job.
 */
import type { JudgeLike } from "./agent.js";
import { defaultBudgetDeps, runPrReview, type RunPrReviewDeps } from "./agent.js";
import { resolveAcceptanceCriteriaForPr } from "./ac-traceability.js";
import { fetchPrDiff, type DiffFetchOctokit } from "./diff-fetcher.js";
import type { OctokitLike } from "./github-review-poster.js";
import { auditPrReviewSkipped } from "./pr-audit.js";
import type { PrReviewJob } from "./queue.js";
import { computeRunCost, finishRun, recordStep, startRun } from "../../replay/runs-service.js";

export interface ExecutePrReviewJobDeps {
  judge?: JudgeLike;
  octokit?: OctokitLike & DiffFetchOctokit;
  budget?: RunPrReviewDeps["budget"];
}

export interface ExecutePrReviewJobResult {
  /**
   * Why the job was short-circuited, or `null` when the review ran to
   * completion (review may itself be `skipped` — see the agent result).
   */
  skipped:
    | "no_judge_or_octokit"
    | "no_project_or_auto_review_disabled"
    | "ac_resolve_skip"
    | "diff_fetch_failed"
    | "diff_too_large"
    | null;
  runId: string | null;
}

/** Project facts the executor needs — the caller resolves these. */
export interface PrReviewJobProject {
  id: string;
  autoReviewPrs: boolean;
  prReviewMaxDiffBytes: number | null;
  prReviewSkipGlobs: string | null;
}

export interface ExecutePrReviewJobInput {
  job: PrReviewJob;
  project: PrReviewJobProject | null;
  /** PR title — sourced from the webhook payload (or persisted state). */
  prTitle: string;
  prBody: string;
  prUrl: string;
  installationId: string | null;
  /** Actor metadata for audit rows. */
  actor: { type: "webhook" | "system" | "user"; id: string | null };
}

/**
 * Run the full PR-review pipeline for an enqueued job. Mirrors the
 * pre-extraction inline flow in `routes/webhooks-github.ts` so the
 * worker queue and the legacy synchronous fallback produce identical
 * audit + AgentRun rows.
 */
export async function executePrReviewJob(
  input: ExecutePrReviewJobInput,
  deps: ExecutePrReviewJobDeps,
): Promise<ExecutePrReviewJobResult> {
  if (!deps.judge || !deps.octokit) {
    return { skipped: "no_judge_or_octokit", runId: null };
  }
  if (!input.project || !input.project.autoReviewPrs) {
    return { skipped: "no_project_or_auto_review_disabled", runId: null };
  }

  const { job, project, prTitle, prBody, prUrl, installationId, actor } = input;

  const acResult = await resolveAcceptanceCriteriaForPr({
    prBody,
    branchName: (job.context.branchName as string | null) ?? null,
    repoOwner: job.owner,
    repoName: job.repo,
    projectId: project.id,
  });
  if (acResult.skipReason) {
    auditPrReviewSkipped({
      prUrl,
      prNumber: job.prNumber,
      repoOwner: job.owner,
      repoName: job.repo,
      installationId,
      linkedIssueNumbers: acResult.linkedIssueNumbers,
      actor,
      projectId: project.id,
      reason: acResult.skipReason,
    });
    return { skipped: "ac_resolve_skip", runId: null };
  }

  const skipGlobs = parseSkipGlobs(project.prReviewSkipGlobs);
  let diffOut;
  try {
    diffOut = await fetchPrDiff({
      octokit: deps.octokit,
      owner: job.owner,
      repo: job.repo,
      prNumber: job.prNumber,
      maxBytes: project.prReviewMaxDiffBytes ?? null,
      skipGlobs,
    });
  } catch (err) {
    auditPrReviewSkipped({
      prUrl,
      prNumber: job.prNumber,
      repoOwner: job.owner,
      repoName: job.repo,
      installationId,
      linkedIssueNumbers: acResult.linkedIssueNumbers,
      actor,
      projectId: project.id,
      reason: "diff_too_large",
      details: { errorMessage: (err as Error).message },
    });
    return { skipped: "diff_fetch_failed", runId: null };
  }
  if (diffOut.tooLarge) {
    auditPrReviewSkipped({
      prUrl,
      prNumber: job.prNumber,
      repoOwner: job.owner,
      repoName: job.repo,
      installationId,
      linkedIssueNumbers: acResult.linkedIssueNumbers,
      actor,
      projectId: project.id,
      reason: "diff_too_large",
      details: { rawBytes: diffOut.rawBytes },
    });
    return { skipped: "diff_too_large", runId: null };
  }

  const sessionId = job.deliveryId
    ? `pr-review-${job.prNumber}-${job.deliveryId}`
    : `pr-review-${job.prNumber}-${Date.now()}`;
  const runId = await startRun({
    sessionId,
    projectId: project.id,
    kind: "tool",
  });
  const budget = deps.budget ?? defaultBudgetDeps();
  const action = (job.context.action as string | undefined) ?? "queued";
  try {
    const result = await runPrReview(
      {
        owner: job.owner,
        repo: job.repo,
        prNumber: job.prNumber,
        prTitle,
        prBody,
        diff: diffOut.diff,
        criteria: acResult.criteria,
        octokit: deps.octokit,
        projectId: project.id,
        prUrl,
        installationId,
        actor,
        linkedIssueNumbers: acResult.linkedIssueNumbers,
      },
      { judge: deps.judge, budget },
    );
    await recordStep({
      runId,
      kind: "tool_result",
      content: { kind: "pr_review", action, result },
    });
    // Attribute real LLM cost for this run from in-window TokenUsage rows.
    const cost = await computeRunCost(runId).catch(() => ({ costCents: 0, totalTokens: 0 }));
    await finishRun({ runId, status: "completed", ...cost });
    return { skipped: null, runId };
  } catch (err) {
    await recordStep({
      runId,
      kind: "tool_result",
      content: { kind: "pr_review_error", error: (err as Error).message },
    });
    // A failed review may still have incurred spend before throwing; attribute
    // whatever usage landed in-window so the run isn't reported as free.
    const cost = await computeRunCost(runId).catch(() => ({ costCents: 0, totalTokens: 0 }));
    await finishRun({ runId, status: "failed", ...cost });
    return { skipped: null, runId };
  }
}

function parseSkipGlobs(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const arr = JSON.parse(raw) as unknown;
    if (Array.isArray(arr)) return arr.filter((x): x is string => typeof x === "string");
  } catch {
    // ignore — return null to signal "no skip globs"
  }
  return null;
}
