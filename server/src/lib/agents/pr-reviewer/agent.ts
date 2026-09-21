/**
 * Epic #192 (A.4) + Epic #394 MVP — PR-reviewer agent.
 *
 * Orchestrates: linked requirement ACs (#398) → judge LLM → (optionally)
 * AC-mapped sandbox tests → post a structured GitHub review → emit
 * `pr.reviewed` audit + record token spend (#400, #401). The judge LLM and
 * GitHub poster are both injected so tests can drive the agent end-to-end
 * without network or model calls.
 *
 * Backwards compatibility: callers that already pre-fetched the diff and
 * resolved ACs can pass them in directly via `RunPrReviewInput`. New
 * callers (the webhook handler and the `/api/run-reviews` route) should
 * pass the audit/budget context so the agent owns the full pipeline.
 */
import {
  buildPrReviewSystemPrompt,
  buildPrReviewUserPrompt,
  parseJudgeResponse,
  type AcceptanceCriterionInput,
  type JudgeResponse,
} from "./prompts.js";
import { postPrReview, type OctokitLike } from "./github-review-poster.js";
import {
  auditPrReviewed,
  auditPrReviewErrored,
  auditPrReviewSkipped,
  type PrReviewSkipReason,
} from "./pr-audit.js";
import { PR_REVIEW_SESSION_PREFIX, checkBudget, recordPrReviewSpend } from "./budget-guard.js";

/**
 * Minimal judge-LLM interface. The legacy form returns a raw JSON string
 * only. New callers may return a `JudgeEnvelope` to surface model id,
 * token counts, and cost so the agent can record audit + spend rows.
 */
export interface JudgeLike {
  evaluate(input: { system: string; user: string }): Promise<string | JudgeEnvelope>;
}

export interface JudgeEnvelope {
  raw: string;
  model?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  provider?: string | null;
}

export interface SandboxLike {
  exec(input: { language: "python" | "node" | "bash"; code: string; timeoutMs?: number }): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
    durationMs: number;
    truncated: boolean;
  }>;
}

export interface RunPrReviewInput {
  owner: string;
  repo: string;
  prNumber: number;
  prTitle: string;
  prBody: string;
  diff: string;
  criteria: AcceptanceCriterionInput[];
  /** Optional: AC-mapped commands to run in the sandbox after judging. */
  testCommands?: Array<{ acId: string; language: "python" | "node" | "bash"; code: string }>;
  octokit: OctokitLike;
  /** Optional context used by audit / budget paths (Epic #394 MVP). */
  projectId?: string | null;
  prUrl?: string | null;
  installationId?: string | null;
  actor?: { type: "user" | "system" | "webhook"; id: string | null };
  linkedIssueNumbers?: number[];
}

export interface RunPrReviewDeps {
  judge: JudgeLike;
  sandbox?: SandboxLike;
  /** Pre-flight budget check (Epic #394 / #401). When omitted the check is skipped. */
  budget?: {
    check: (projectId: string) => Promise<{
      allowed: boolean;
      capCents: number | null;
      spentCents: number;
      resetAt: string;
    }>;
    record: (input: {
      projectId: string;
      sessionId: string;
      provider: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
      costUsd: number;
    }) => Promise<void>;
  };
}

export interface SandboxTestResult {
  acId: string;
  exitCode: number;
  durationMs: number;
  truncated: boolean;
  stdout: string;
  stderr: string;
}

export interface RunPrReviewResult {
  judge: JudgeResponse;
  sandboxResults: SandboxTestResult[];
  reviewId: number | null;
  reviewUrl: string | null;
  postedAt: string | null;
  /** When the agent short-circuited, the reason; otherwise `null`. */
  skipped: PrReviewSkipReason | null;
  /** Effective verdict after sandbox + budget paths; null when skipped. */
  verdict: "approve" | "request_changes" | "comment" | null;
  /** Telemetry captured for audit (always returned, even on skip). */
  telemetry: {
    model: string | null;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    latencyMs: number;
    acPassRate: number;
  };
}

const EMPTY_TELEMETRY = {
  model: null,
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  latencyMs: 0,
  acPassRate: 0,
} as const;

const SKIPPED_RESULT_BASE = {
  judge: {
    verdicts: [],
    comments: [],
    overallVerdict: "comment",
    summary: "",
  } as JudgeResponse,
  sandboxResults: [] as SandboxTestResult[],
  reviewId: null,
  reviewUrl: null,
  postedAt: null,
  verdict: null,
};

export async function runPrReview(
  input: RunPrReviewInput,
  deps: RunPrReviewDeps,
): Promise<RunPrReviewResult> {
  const auditCommon = {
    prUrl: input.prUrl ?? "",
    prNumber: input.prNumber,
    repoOwner: input.owner,
    repoName: input.repo,
    installationId: input.installationId ?? null,
    linkedIssueNumbers: input.linkedIssueNumbers ?? [],
    actor: input.actor ?? { type: "system" as const, id: null },
    projectId: input.projectId ?? null,
  };

  if (input.criteria.length === 0) {
    auditPrReviewSkipped({ ...auditCommon, reason: "no_linked_issue" });
    return {
      ...SKIPPED_RESULT_BASE,
      judge: {
        ...SKIPPED_RESULT_BASE.judge,
        summary: "No acceptance criteria linked to this PR — skipping review.",
      },
      skipped: "no_linked_issue",
      telemetry: { ...EMPTY_TELEMETRY },
    };
  }

  // Budget guard (#401) — must run before any LLM call so we never bill a
  // project that's already over its monthly cap.
  if (deps.budget && input.projectId) {
    const status = await deps.budget.check(input.projectId);
    if (!status.allowed) {
      auditPrReviewSkipped({
        ...auditCommon,
        reason: "budget_exceeded",
        details: {
          capCents: status.capCents,
          spentCents: status.spentCents,
          resetAt: status.resetAt,
        },
      });
      return {
        ...SKIPPED_RESULT_BASE,
        judge: {
          ...SKIPPED_RESULT_BASE.judge,
          summary: "Monthly PR-review budget exceeded — skipping review.",
        },
        skipped: "budget_exceeded",
        telemetry: { ...EMPTY_TELEMETRY },
      };
    }
  }

  const system = buildPrReviewSystemPrompt();
  const user = buildPrReviewUserPrompt({
    prTitle: input.prTitle,
    prBody: input.prBody,
    diff: input.diff,
    criteria: input.criteria,
  });

  const startedAt = Date.now();
  let envelope: JudgeEnvelope;
  try {
    const out = await deps.judge.evaluate({ system, user });
    envelope = typeof out === "string" ? { raw: out } : out;
  } catch (err) {
    auditPrReviewErrored({
      ...auditCommon,
      errorMessage: (err as Error).message,
      latencyMs: Date.now() - startedAt,
      model: null,
    });
    throw err;
  }

  let judge: JudgeResponse;
  try {
    judge = parseJudgeResponse(envelope.raw);
  } catch (err) {
    auditPrReviewErrored({
      ...auditCommon,
      errorMessage: `judge response parse failed: ${(err as Error).message}`,
      latencyMs: Date.now() - startedAt,
      model: envelope.model ?? null,
    });
    throw err;
  }

  // Optionally run AC-mapped tests in the sandbox. Failures here downgrade
  // the verdict from approve to request_changes (we never silently approve
  // when sandbox tests fail).
  const sandboxResults: SandboxTestResult[] = [];
  if (deps.sandbox && input.testCommands?.length) {
    for (const tc of input.testCommands) {
      try {
        const r = await deps.sandbox.exec({ language: tc.language, code: tc.code });
        sandboxResults.push({ acId: tc.acId, ...r });
      } catch (err) {
        sandboxResults.push({
          acId: tc.acId,
          exitCode: 1,
          durationMs: 0,
          truncated: false,
          stdout: "",
          stderr: (err as Error).message,
        });
      }
    }
  }

  const sandboxFailed = sandboxResults.some((r) => r.exitCode !== 0);
  let overall = judge.overallVerdict;
  if (sandboxFailed && overall === "approve") {
    overall = "request_changes";
  }

  const summary = sandboxFailed
    ? `${judge.summary}\n\n⚠ Sandbox tests failed for ${sandboxResults.filter((r) => r.exitCode !== 0).length} AC(s).`
    : judge.summary;

  let posted: { reviewId: number; reviewUrl: string };
  try {
    posted = await postPrReview({
      octokit: input.octokit,
      owner: input.owner,
      repo: input.repo,
      prNumber: input.prNumber,
      verdict: overall,
      summary,
      inlineComments: judge.comments.map((c) => ({
        filePath: c.filePath,
        line: c.line,
        body: `[${c.severity}] ${c.body}`,
      })),
    });
  } catch (err) {
    auditPrReviewErrored({
      ...auditCommon,
      errorMessage: `postPrReview failed: ${(err as Error).message}`,
      latencyMs: Date.now() - startedAt,
      model: envelope.model ?? null,
    });
    throw err;
  }

  const latencyMs = Date.now() - startedAt;
  const acPassRate = computeAcPassRate(judge);
  const inputTokens = envelope.inputTokens ?? 0;
  const outputTokens = envelope.outputTokens ?? 0;
  const costUsd = envelope.costUsd ?? 0;
  const model = envelope.model ?? null;

  // Record spend (#401) BEFORE emitting the audit row so the audit metadata
  // accurately reflects what landed in TokenUsage.
  if (deps.budget && input.projectId && (inputTokens > 0 || outputTokens > 0 || costUsd > 0)) {
    try {
      await deps.budget.record({
        projectId: input.projectId,
        sessionId: `${PR_REVIEW_SESSION_PREFIX}${input.owner}-${input.repo}-${input.prNumber}-${startedAt}`,
        provider: envelope.provider ?? "unknown",
        model: model ?? "unknown",
        inputTokens,
        outputTokens,
        costUsd,
      });
    } catch {
      // Spend tracking is best-effort — never fail a review on a TokenUsage write.
    }
  }

  auditPrReviewed({
    ...auditCommon,
    verdict: overall,
    acPassRate,
    model,
    inputTokens,
    outputTokens,
    costUsd,
    latencyMs,
    reviewId: posted.reviewId,
    reviewUrl: posted.reviewUrl,
  });

  return {
    judge: { ...judge, overallVerdict: overall, summary },
    sandboxResults,
    reviewId: posted.reviewId,
    reviewUrl: posted.reviewUrl,
    postedAt: new Date().toISOString(),
    skipped: null,
    verdict: overall,
    telemetry: { model, inputTokens, outputTokens, costUsd, latencyMs, acPassRate },
  };
}

/**
 * Convenience wrapper for the webhook + manual route paths: builds the
 * default budget deps from the production singletons. Pulled out of
 * `runPrReview` so unit tests can keep injecting hermetic stubs.
 */
export function defaultBudgetDeps(): NonNullable<RunPrReviewDeps["budget"]> {
  return {
    check: async (projectId) => {
      const r = await checkBudget(projectId);
      return {
        allowed: r.allowed,
        capCents: r.capCents,
        spentCents: r.spentCents,
        resetAt: r.resetAt,
      };
    },
    record: (input) => recordPrReviewSpend(input),
  };
}

function computeAcPassRate(judge: JudgeResponse): number {
  if (judge.verdicts.length === 0) return 0;
  const satisfied = judge.verdicts.filter((v) => v.verdict === "satisfied").length;
  return satisfied / judge.verdicts.length;
}
