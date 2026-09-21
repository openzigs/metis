/**
 * Epic #194 (C.5) — Eval / leaderboard API client.
 */
import { apiFetch } from "@/lib/api-client";

export type Bench = "swe-bench-pro" | "tau-bench";

export interface BenchRunSummary {
  id: string;
  benchmark: string;
  model: string;
  score: number;
  totalTasks: number;
  passedTasks: number;
  meanTokens: number;
  meanCostCents: number;
  meanLatencyMs: number;
  startedAt: string;
  completedAt: string | null;
  status: string;
}

export interface BenchTaskRow {
  id: string;
  taskId: string;
  passed: boolean;
  score: number;
  tokens: number;
  costCents: number;
  latencyMs: number;
  expected: string | null;
  actual: string | null;
  error: string | null;
}

export interface BenchRunDetail {
  run: BenchRunSummary & { metadata: unknown };
  tasks: BenchTaskRow[];
}

export interface TriggerResult {
  benchRunId: string | null;
  status: string;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Epic #803 (Epic 09) — Domain Eval (BA pipeline regression suite).
// Mirrors the shared `DomainEvalRun*` schemas. Kept as a local mirror rather
// than importing @metis/shared so the UI bundle stays free of the server's
// zod dependency surface.
// ---------------------------------------------------------------------------

export type DomainDocType = "prd" | "brd" | "user-story";

export interface DomainRequirement {
  id: string;
  type: string;
  title: string;
  description: string;
  priority: string;
  confidence?: number;
}

export interface DomainMatch {
  expectedId: string | null;
  predictedId: string | null;
  titleSimilarity: number;
  rougeL: number;
  confidence: number | null;
}

export interface DomainCalibrationBin {
  bucket: string;
  lowerBound: number;
  upperBound: number;
  count: number;
  meanConfidence: number;
  accuracy: number;
}

export interface DomainDrift {
  previousF1: number | null;
  deltaF1: number | null;
  thresholdPct: number;
  alert: boolean;
  reason: string;
  /**
   * #1333 — which run this verdict was measured against, and how stale it was.
   * The API `safeParse`s each envelope through `domainDriftSchema`, whose
   * defaults fill these in for the 66 envelopes written before the fix, so they
   * are always present on the wire even for historical runs.
   */
  baselineRunId: string | null;
  baselineAgeDays: number | null;
  staleBaseline: boolean;
}

export interface DomainItemResult {
  itemId: string;
  docType: DomainDocType;
  title: string;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  f1: number;
  meanRougeL: number;
  matches: DomainMatch[];
  expected: DomainRequirement[];
  predicted: DomainRequirement[];
}

export interface DomainEvalRunSummary {
  runId: string;
  schemaVersion: number;
  model: string;
  startedAt: string;
  completedAt: string;
  itemCount: number;
  corpusPrecision: number;
  corpusRecall: number;
  corpusF1: number;
  meanRougeL: number;
  totalTokens: number;
  totalCostCents: number;
  commit: string | null;
  drift: DomainDrift;
  driftAlert: boolean;
}

export interface DomainEvalRunDetail extends Omit<DomainEvalRunSummary, "driftAlert"> {
  calibration: DomainCalibrationBin[];
  items: DomainItemResult[];
}

export const domainEvalApi = {
  async listRuns(opts: { days?: number } = {}): Promise<{ runs: DomainEvalRunSummary[] }> {
    return await apiFetch<{ runs: DomainEvalRunSummary[] }>("/eval/domain/runs", {
      method: "GET",
      params: { days: opts.days },
    });
  },
  async getRun(id: string): Promise<DomainEvalRunDetail> {
    // The read API wraps the detail envelope as `{ run }` (see
    // server/src/routes/eval-domain.ts → `ok({ run })`), so unwrap it here to
    // hand the panel a flat `DomainEvalRunDetail`.
    const { run } = await apiFetch<{ run: DomainEvalRunDetail }>(
      `/eval/domain/runs/${encodeURIComponent(id)}`,
      { method: "GET" },
    );
    return run;
  },
};

export const evalApi = {
  async listLeaderboard(opts: { bench?: Bench; days?: number } = {}): Promise<{
    runs: BenchRunSummary[];
  }> {
    return await apiFetch<{ runs: BenchRunSummary[] }>("/eval/leaderboard", {
      method: "GET",
      params: {
        bench: opts.bench,
        days: opts.days,
      },
    });
  },
  async getRun(id: string): Promise<BenchRunDetail> {
    return await apiFetch<BenchRunDetail>(`/eval/leaderboard/runs/${encodeURIComponent(id)}`, {
      method: "GET",
    });
  },
  async triggerRun(input: {
    bench: Bench;
    model?: string;
    costCapCents?: number;
  }): Promise<TriggerResult> {
    return await apiFetch<TriggerResult>("/eval/leaderboard/run", {
      method: "POST",
      body: input,
    });
  },
};

// ---------------------------------------------------------------------------
// Epic #1316 / issue #1321 — Online Eval (sampled live production runs).
// Mirrors the shared `OnlineEval*` schemas. Local mirror, same rationale as the
// Domain Eval block above: keep zod out of the UI bundle.
// ---------------------------------------------------------------------------

export type RagasMetricKey =
  | "context_precision"
  | "context_recall"
  | "faithfulness"
  | "answer_relevancy";

/**
 * One judgement, mirroring the shared `ragasJudgementSchema`.
 *
 * A metric is `null` when the judge could not decide it — UNVERIFIABLE, not a
 * zero (#1317/#1329). Rendering code MUST branch on null rather than doing
 * arithmetic on it: `null * 100` is `0` in JavaScript, so a missing measurement
 * silently paints itself as a confident 0.0%.
 */
export interface RagasJudgement {
  context_precision: number | null;
  context_recall: number | null;
  faithfulness: number | null;
  answer_relevancy: number | null;
}

/** Per-metric count of samples that produced a number vs. were unverifiable. */
export interface RagasCoverage {
  context_precision: number;
  context_recall: number;
  faithfulness: number;
  answer_relevancy: number;
}

export interface OnlineEvalDrift {
  metric: RagasMetricKey;
  previous: number | null;
  delta: number | null;
  thresholdPct: number;
  alert: boolean;
  reason: string;
}

export interface OnlineEvalBudgetState {
  monthBucket: string;
  tokensUsed: number;
  tokensCap: number;
  calls: number;
}

/** Content-free by construction — digests and sizes only (see server store.ts). */
export interface OnlineEvalSample {
  sampleId: string;
  surface: "chat" | "analysis" | "docs-gen";
  observedAt: string;
  questionHash: string;
  answerHash: string;
  questionChars: number;
  answerChars: number;
  contextCount: number;
  contextChars: number;
  redactionHits: number;
  scores: RagasJudgement;
  tokensCharged: number;
}

export interface OnlineEvalWindowSummary {
  windowId: string;
  schemaVersion: number;
  startedAt: string;
  completedAt: string;
  judge: string;
  /** False while the judge is the lexical stub — scores are NOT a quality signal. */
  judgeMeaningful: boolean;
  sampleCount: number;
  /** Mean over the SCORED samples only; `null` for a metric nothing scored. */
  meanScores: RagasJudgement;
  /** How many samples produced a number for each metric. */
  scored: RagasCoverage;
  /** How many samples were UNVERIFIABLE for each metric (excluded from the mean). */
  unverifiable: RagasCoverage;
  trendedMetrics: RagasMetricKey[];
  drift: OnlineEvalDrift;
  budget: OnlineEvalBudgetState;
  driftAlert: boolean;
}

export interface OnlineEvalWindowDetail extends Omit<OnlineEvalWindowSummary, "driftAlert"> {
  samples: OnlineEvalSample[];
}

export interface OnlineEvalStatus {
  enabled: boolean;
  sampleRate: number;
  windowSize: number;
  driftAlertsEnabled: boolean;
  judge: string;
  judgeMeaningful: boolean;
  pendingSamples: number;
  budget: OnlineEvalBudgetState;
}

export const onlineEvalApi = {
  async listWindows(opts: { days?: number } = {}): Promise<{ windows: OnlineEvalWindowSummary[] }> {
    return await apiFetch<{ windows: OnlineEvalWindowSummary[] }>("/eval/online/windows", {
      method: "GET",
      params: { days: opts.days },
    });
  },
  async getStatus(): Promise<OnlineEvalStatus> {
    const { status } = await apiFetch<{ status: OnlineEvalStatus }>("/eval/online/status", {
      method: "GET",
    });
    return status;
  },
};
