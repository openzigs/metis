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
import {
  defaultBudgetDeps,
  runPrReview,
  type RunPrReviewDeps,
  type RunPrReviewResult,
} from "./agent.js";
import { resolveAcceptanceCriteriaForPr } from "./ac-traceability.js";
import { fetchPrDiff, type DiffFetchOctokit } from "./diff-fetcher.js";
import type { OctokitLike } from "./github-review-poster.js";
import { auditPrReviewSkipped } from "./pr-audit.js";
import type { PrReviewJob } from "./queue.js";
import { recordPrReviewOutcome, type PrReviewOutcome } from "./state-repo.js";
import { computeRunCost, finishRun, recordStep, startRun } from "../../replay/runs-service.js";
import { createChildLogger } from "../../logger.js";

const log = createChildLogger("pr-review-job");

/**
 * #1470 — write the job's outcome to its `PrReviewState` row, which is what
 * `/projects/:id/pulls` lists. Keyed by the project the caller resolved (never
 * by anything in the job payload alone) + repo + PR number. Best-effort: the
 * review itself is already posted or skipped, so a failed write is logged, not
 * thrown.
 */
async function recordOutcome(
  projectId: string,
  job: PrReviewJob,
  outcome: PrReviewOutcome,
): Promise<void> {
  try {
    await recordPrReviewOutcome(
      { projectId, repoOwner: job.owner, repoName: job.repo, prNumber: job.prNumber },
      outcome,
    );
  } catch (err) {
    log.warn("pr_review.state_write_failed", {
      deliveryId: job.deliveryId,
      repo: `${job.owner}/${job.repo}`,
      prNumber: job.prNumber,
      status: outcome.status,
      error: errorMessage(err),
    });
  }
}

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
    | "budget_preflight"
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
 * #1471 — record a job the worker refused before resolving a GitHub client
 * (the budget preflight): the same `pr.review_skipped` audit and state row
 * `runPrReview`'s own refusal writes. Nothing is reviewed or spent.
 */
export async function recordPrReviewJobSkip(
  input: ExecutePrReviewJobInput,
  reason: "budget_exceeded" | "budget_unpriced",
  details: Record<string, unknown>,
): Promise<ExecutePrReviewJobResult> {
  const { job, project, prUrl, installationId, actor } = input;
  if (!project) return { skipped: "no_project_or_auto_review_disabled", runId: null };
  auditPrReviewSkipped({
    prUrl,
    prNumber: job.prNumber,
    repoOwner: job.owner,
    repoName: job.repo,
    installationId,
    linkedIssueNumbers: [],
    actor,
    projectId: project.id,
    reason,
    details,
  });
  await recordOutcome(project.id, job, { status: "skipped", reason });
  return { skipped: "budget_preflight", runId: null };
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
  if (!input.project) {
    return { skipped: "no_project_or_auto_review_disabled", runId: null };
  }
  if (!input.project.autoReviewPrs) {
    // #1470 — a job queued before review was switched off reaches here
    // (`resolveProjectForQueuedReview`); nothing is reviewed or spent.
    await recordOutcome(input.project.id, input.job, {
      status: "skipped",
      reason: "auto_review_disabled",
    });
    return { skipped: "no_project_or_auto_review_disabled", runId: null };
  }
  if (!deps.judge || !deps.octokit) {
    // #1470 — the server has no review model or GitHub client to review with.
    await recordOutcome(input.project.id, input.job, {
      status: "skipped",
      reason: "review_not_configured",
    });
    return { skipped: "no_judge_or_octokit", runId: null };
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
    await recordOutcome(project.id, job, { status: "skipped", reason: acResult.skipReason });
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
    await recordOutcome(project.id, job, { status: "skipped", reason: "diff_unavailable" });
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
    await recordOutcome(project.id, job, { status: "skipped", reason: "diff_too_large" });
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
  let result: RunPrReviewResult | null = null;
  let reviewError: unknown = null;
  try {
    result = await runPrReview(
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
        // #1486 — spend is recorded under this run's session, which is what
        // `computeRunCost` reads back for it below.
        sessionId,
      },
      { judge: deps.judge, budget },
    );
  } catch (err) {
    reviewError = err;
  }

  // #1486 — from here the model has been called and the review may be on the
  // pull request, so nothing below may throw: a throw reaches the queue, which
  // retries the whole job, calling the model and posting the review again.
  // Every step is best-effort and logged; none decides the review's outcome.
  // (Idempotency on the post alone would not do: the model call comes first.)
  const bestEffort = (step: string, fn: () => Promise<unknown>) =>
    Promise.resolve()
      .then(fn)
      .catch((err: unknown) => {
        log.warn("pr_review.bookkeeping_failed", {
          deliveryId: job.deliveryId,
          repo: `${job.owner}/${job.repo}`,
          prNumber: job.prNumber,
          runId,
          step,
          error: errorMessage(err),
        });
      });

  // `recordOutcome` already never throws.
  await recordOutcome(
    project.id,
    job,
    !result
      ? { status: "failed", runId }
      : result.skipped
        ? { status: "skipped", reason: result.skipped }
        : {
            status: "reviewed",
            headSha: (job.context.headSha as string | null | undefined) ?? null,
            acVerdicts: result.judge.verdicts,
            runId,
            verdict: result.verdict ?? result.judge.overallVerdict,
            reviewUrl: result.reviewUrl,
          },
  );
  await bestEffort("record_step", () =>
    recordStep({
      runId,
      kind: "tool_result",
      content: result
        ? { kind: "pr_review", action, result }
        : { kind: "pr_review_error", error: errorMessage(reviewError) },
    }),
  );
  // Attribute the run's LLM cost from in-window TokenUsage rows — on a failed
  // review too, since its spend is recorded as soon as the model answers.
  const cost = await computeRunCost(runId).catch(() => ({ costCents: 0, totalTokens: 0 }));
  await bestEffort("finish_run", () =>
    finishRun({ runId, status: result ? "completed" : "failed", ...cost }),
  );
  return { skipped: null, runId };
}

/** #1486 — a rejection's message, for any thrown value (`undefined` included). */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
