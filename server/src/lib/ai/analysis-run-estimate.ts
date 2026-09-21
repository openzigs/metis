/**
 * Issue #1095 — honest pre-flight estimate for an analysis run.
 *
 * ## Why this module exists
 *
 * `GET /api/projects/:id/analyses/model-recommendation` used to classify the
 * hardcoded sentinel string `"Analyze project documents and codebase"` through
 * {@link TaskProfiler}. That string is 38 characters, so the profiler returned
 * `ceil(38 / 4) = 10` input tokens plus the 0.6 `general` output multiplier —
 * **exactly 16 tokens, for every project, forever**. The profiler was not a
 * stub and it was not broken: it was being fed a constant, because the endpoint
 * took no parameter describing the run. A real run measured 185,167 tokens.
 *
 * ## What replaces it
 *
 * We do NOT invent a formula over corpus bytes. Analysis agents read RAG
 * *retrievals*, not whole documents, so any "80 documents × N bytes" arithmetic
 * would be a plausible-looking fabrication. Instead the estimate is **empirical**:
 * the median per-agent token cost of this project's own previous completed runs,
 * scaled by the number of agents the user has selected for the run they are
 * about to start.
 *
 * When the project has no completed run to learn from there is nothing honest to
 * report, so {@link estimateAnalysisRunTokens} returns `tokens: null` and the UI
 * shows no number at all. A missing estimate is strictly better than a confident
 * wrong one — the whole point of #1095 is that "~16 tokens · ~$0.0000" read as
 * authoritative while being off by ~11,500×.
 */
import type { LatencySLA, ReasoningDepth, TaskProfile, TaskType } from "./types.js";
import { TaskProfiler } from "./task-profiler.js";

/** One previously completed analysis, reduced to what the estimate needs. */
export interface PriorRunSample {
  /** `Analysis.totalTokens` — the measured cost of that run. */
  totalTokens: number;
  /**
   * How many specialist agents that run used, read from `Analysis.metadata`.
   * `null` when the metadata did not record it — such a run is skipped rather
   * than guessed at, since dividing by an assumed agent count would fabricate.
   */
  agentCount: number | null;
}

/** Where a token estimate came from — surfaced so the UI can label it. */
export type RunEstimateBasis = "prior-runs" | "no-history";

export interface AnalysisRunEstimate {
  /** Estimated total tokens, or `null` when no honest estimate is available. */
  tokens: number | null;
  basis: RunEstimateBasis;
  /** How many prior runs backed the estimate (0 for `no-history`). */
  sampleSize: number;
  /** Median measured tokens per agent across those runs. */
  perAgentTokens: number | null;
}

/** Median of a non-empty numeric array. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Estimate the token cost of a planned run from the project's own history.
 *
 * Median (not mean) so one pathological run — a cancelled 500k crawl, a 200-token
 * failure — does not drag the number. Runs without a recorded agent count or
 * without measured tokens are dropped, not imputed.
 */
export function estimateAnalysisRunTokens(
  priorRuns: PriorRunSample[],
  plannedAgentCount: number,
): AnalysisRunEstimate {
  const perAgentSamples = priorRuns
    .filter((r) => r.totalTokens > 0 && r.agentCount != null && r.agentCount > 0)
    .map((r) => r.totalTokens / (r.agentCount as number));

  if (perAgentSamples.length === 0) {
    return { tokens: null, basis: "no-history", sampleSize: 0, perAgentTokens: null };
  }

  const perAgentTokens = Math.round(median(perAgentSamples));
  const agents = Math.max(1, Math.floor(plannedAgentCount));
  return {
    tokens: perAgentTokens * agents,
    basis: "prior-runs",
    sampleSize: perAgentSamples.length,
    perAgentTokens,
  };
}

/**
 * Read the agent count a previous run used out of its `Analysis.metadata` JSON
 * blob (written by `createAnalysis` as `{ agentKeys: [...] }`). Returns `null`
 * when the blob is absent, unparseable, or carries no agent list — the caller
 * then skips that run instead of assuming a count.
 */
export function readAgentCountFromMetadata(metadata: string | null | undefined): number | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata) as { agentKeys?: unknown };
    if (!Array.isArray(parsed.agentKeys) || parsed.agentKeys.length === 0) return null;
    return parsed.agentKeys.length;
  } catch {
    return null;
  }
}

/** Ordering used to pick the deepest reasoning requirement across agents. */
const DEPTH_RANK: Record<ReasoningDepth, number> = { simple: 0, moderate: 1, complex: 2 };

/**
 * A measured run above this many tokens is not a "simple task" whatever the
 * keyword heuristics say. Grounded in the project's OWN measured history, so
 * this promotes depth only on evidence — never on a guess about corpus size.
 */
export const HEAVY_RUN_TOKEN_THRESHOLD = 50_000;

export interface AnalysisRunShape {
  /** The requirement text the user actually typed (may be empty). */
  requirementText: string;
  /** Specialist agents selected for the run. */
  agentKeys: string[];
  /** Empirical token estimate, or `null` when the project has no history. */
  estimatedTokens: number | null;
}

/**
 * Profile the run the user is about to start, from the run's real inputs.
 *
 * Every selected agent is classified against the real requirement text and the
 * deepest result wins — a 4-agent run is profiled by its hardest leg, not by a
 * placeholder sentence.
 *
 * The requirement text is ALSO classified on its own, without an agent hint, and
 * joins the same contest. `TaskProfiler`'s agent heuristics are absolute (any
 * `document` task is "extraction" ⇒ "simple"), so without this the user's text
 * would again have no effect on the answer for some agent selections — a quieter
 * version of the very bug #1095 reports.
 */
export function profileAnalysisRun(shape: AnalysisRunShape): TaskProfile {
  const profiler = new TaskProfiler();
  const content = shape.requirementText.trim();

  const classify = (agentKey?: string): { taskType: TaskType; depth: ReasoningDepth } => {
    const taskType = profiler.classifyTaskType(content, agentKey);
    return { taskType, depth: profiler.classifyReasoningDepth(content, taskType, agentKey) };
  };

  const candidates: Array<{ taskType: TaskType; depth: ReasoningDepth }> = [
    ...shape.agentKeys.map((agentKey) => classify(agentKey)),
    classify(),
  ];

  const deepest = candidates.reduce((best, c) =>
    DEPTH_RANK[c.depth] > DEPTH_RANK[best.depth] ? c : best,
  );

  // Measured history overrides the text heuristics: a project whose runs really
  // cost 185k tokens is not routed as a "simple task" because the prompt was short.
  const depth: ReasoningDepth =
    shape.estimatedTokens != null && shape.estimatedTokens > HEAVY_RUN_TOKEN_THRESHOLD
      ? "complex"
      : deepest.depth;

  const latencySLA: LatencySLA = profiler.classifyLatencySLA(depth, shape.estimatedTokens);

  return {
    tokenEstimate: shape.estimatedTokens,
    reasoningDepth: depth,
    latencySLA,
    taskType: deepest.taskType,
  };
}
