/**
 * Epic #1316 / issue #1321 — online (live-traffic) RAG eval schemas.
 *
 * The offline suites score fixtures. This envelope scores a bounded, sampled
 * fraction of *real* completed runs and writes the aggregate to
 * `eval-results/online/<windowId>.json`.
 *
 * PRIVACY (issue #1321 acceptance criterion): a sample record carries **no user
 * content at all** — only SHA-256 digests, sizes and scores. `eval-results/` is
 * gitignored today (`.gitignore`), but it is a shared operator artifact that is
 * copied around and was committed in the past, so the guarantee is enforced by
 * construction rather than by the ignore rule: both schemas below are
 * `.strict()`, and every free-text field is length-bounded, so a later field
 * carrying text cannot reach disk without a deliberate schema change plus the
 * test that guards it (`server/src/lib/eval/online/store.test.ts`).
 *
 * HONESTY: `judgeMeaningful` is false whenever the configured
 * {@link https://github.com/openzigs/metis-private/issues/1317 RagasJudge} is the
 * lexical `StubRagasJudge`. Live traffic has no ground-truth contexts and no
 * expected-answer keywords, so `context_precision` / `context_recall` are
 * vacuous online for *any* judge — only the two reference-free metrics
 * ({@link ONLINE_EVAL_TRENDED_METRICS}) are ever trended here.
 */
import { z } from "zod";
import { ragasCoverageSchema, ragasJudgementSchema, ragasMetricKeys } from "./rag-hardening.js";

/** Product surfaces that can feed the online scorer. */
export const ONLINE_EVAL_SURFACES = ["chat", "analysis", "docs-gen"] as const;
export type OnlineEvalSurface = (typeof ONLINE_EVAL_SURFACES)[number];

/**
 * Metrics that are meaningful for live traffic. Live runs have no reference
 * answer and no ground-truth spans, so only the reference-free pair is
 * trended; the reference-based pair is still recorded (a future judge may
 * populate it from harvested labels) but never drives an alert.
 */
export const ONLINE_EVAL_TRENDED_METRICS = ["faithfulness", "answer_relevancy"] as const;

/** Conservative defaults — the feature ships OFF (issue #1321). */
export const DEFAULT_ONLINE_EVAL_ENABLED = false;
/** 1% of eligible runs. */
export const DEFAULT_ONLINE_EVAL_SAMPLE_RATE = 0.01;
/** Separate from `ANALYSIS_MONTHLY_TOKEN_CAP` — online scoring gets its own. */
export const DEFAULT_ONLINE_EVAL_MONTHLY_TOKEN_BUDGET = 250_000;
/** Pre-call charge used to reserve budget before a judge call is made. */
export const DEFAULT_ONLINE_EVAL_TOKENS_PER_SCORE = 1_500;
/** Samples per aggregation window. */
export const DEFAULT_ONLINE_EVAL_WINDOW_SIZE = 20;
/** Week-over-window drop that counts as drift. */
export const DEFAULT_ONLINE_EVAL_DRIFT_THRESHOLD_PCT = 0.05;
/** Redacted text handed to the judge is truncated to this many characters. */
export const DEFAULT_ONLINE_EVAL_MAX_CHARS = 4_000;
/**
 * Hard cap on every free-text field persisted in an online-eval envelope
 * (`drift.reason`, `judge`). Mirrored by `store.assertContentFree`, which is
 * the belt to this schema's braces.
 */
export const ONLINE_EVAL_MAX_REASON_CHARS = 200;

/**
 * One scored live run. Content-free by construction — see the file header.
 */
export const onlineEvalSampleSchema = z
  .object({
    sampleId: z.string().min(1).max(64),
    surface: z.enum(ONLINE_EVAL_SURFACES),
    observedAt: z.string(),
    /** SHA-256 (hex) of the *redacted* question. Not reversible to content. */
    questionHash: z.string().regex(/^[a-f0-9]{64}$/),
    /** SHA-256 (hex) of the *redacted* answer. */
    answerHash: z.string().regex(/^[a-f0-9]{64}$/),
    questionChars: z.number().int().min(0),
    answerChars: z.number().int().min(0),
    contextCount: z.number().int().min(0),
    contextChars: z.number().int().min(0),
    /** Number of PII substitutions the redactor made across question+answer+contexts. */
    redactionHits: z.number().int().min(0),
    /**
     * #1329 — a metric is `null` when this judge could not decide it for this
     * sample (UNVERIFIABLE). It is not a zero: `meanScores` excludes it from
     * both the numerator and the denominator.
     */
    scores: ragasJudgementSchema,
    /** Tokens charged against the online-eval budget for this sample. */
    tokensCharged: z.number().int().min(0),
  })
  .strict();
export type OnlineEvalSample = z.infer<typeof onlineEvalSampleSchema>;

export const onlineEvalDriftSchema = z
  .object({
    metric: z.enum(ragasMetricKeys),
    previous: z.number().nullable(),
    /** current − previous (negative = regression). */
    delta: z.number().nullable(),
    thresholdPct: z.number().min(0).max(1),
    alert: z.boolean(),
    /**
     * Machine-readable drift verdict (`DRIFT`, `WITHIN_THRESHOLD`,
     * `SUPPRESSED_STUB_JUDGE`, `NO_PREVIOUS_WINDOW`, `NO_COMPARABLE_BASELINE`,
     * `UNVERIFIABLE_METRIC`, `BASELINE_UNVERIFIABLE`).
     * Bounded because `store.assertContentFree` allows free text here: an
     * unbounded string is the one place a future author could interpolate user
     * content into a persisted envelope.
     */
    reason: z.string().max(ONLINE_EVAL_MAX_REASON_CHARS),
  })
  .strict();
export type OnlineEvalDrift = z.infer<typeof onlineEvalDriftSchema>;

export const onlineEvalBudgetStateSchema = z
  .object({
    monthBucket: z.string().regex(/^\d{4}-\d{2}$/),
    tokensUsed: z.number().int().min(0),
    tokensCap: z.number().int().min(0),
    calls: z.number().int().min(0),
  })
  .strict();
export type OnlineEvalBudgetState = z.infer<typeof onlineEvalBudgetStateSchema>;

export const onlineEvalWindowSchema = z
  .object({
    windowId: z.string().min(1).max(128),
    schemaVersion: z.number().int().min(1).default(1),
    startedAt: z.string(),
    completedAt: z.string(),
    /** Name of the `RagasJudge` implementation that produced the scores. */
    judge: z.string().min(1).max(128),
    /**
     * False while the judge is the lexical stub (#1317). Consumers MUST NOT
     * present the scores as a quality signal when this is false.
     */
    judgeMeaningful: z.boolean(),
    sampleCount: z.number().int().min(0),
    /**
     * Mean over the SCORED samples only (#1329). A metric no sample in this
     * window could be scored on is `null` — never `0`. Counting an
     * UNVERIFIABLE metric as zero would manufacture a drift alert out of a
     * judge outage, which is strictly worse than the vacuous `1.0` #1317
     * removed. Mirrors `averageScores` in `server/src/lib/rag/ragas.ts`.
     */
    meanScores: ragasJudgementSchema,
    /** Per-metric count of samples in this window that produced a number. */
    scored: ragasCoverageSchema,
    /** Per-metric count of samples that were UNVERIFIABLE (excluded from the mean). */
    unverifiable: ragasCoverageSchema,
    trendedMetrics: z.array(z.enum(ragasMetricKeys)),
    drift: onlineEvalDriftSchema,
    budget: onlineEvalBudgetStateSchema,
    samples: z.array(onlineEvalSampleSchema),
  })
  .strict();
export type OnlineEvalWindow = z.infer<typeof onlineEvalWindowSchema>;

/** Compact list/trend projection — drops the per-sample payload. */
export const onlineEvalWindowSummarySchema = onlineEvalWindowSchema
  .omit({ samples: true })
  .extend({ driftAlert: z.boolean() });
export type OnlineEvalWindowSummary = z.infer<typeof onlineEvalWindowSummarySchema>;

export function toOnlineWindowSummary(w: OnlineEvalWindow): OnlineEvalWindowSummary {
  const { samples: _samples, ...rest } = w;
  return { ...rest, driftAlert: w.drift.alert };
}

/** Operator-facing status of the online scorer (no content, no secrets). */
export const onlineEvalStatusSchema = z
  .object({
    enabled: z.boolean(),
    sampleRate: z.number().min(0).max(1),
    windowSize: z.number().int().min(1),
    driftAlertsEnabled: z.boolean(),
    judge: z.string(),
    judgeMeaningful: z.boolean(),
    pendingSamples: z.number().int().min(0),
    budget: onlineEvalBudgetStateSchema,
  })
  .strict();
export type OnlineEvalStatus = z.infer<typeof onlineEvalStatusSchema>;
