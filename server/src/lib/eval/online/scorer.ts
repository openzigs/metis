/**
 * Epic #1316 / issue #1321 — online (live-traffic) eval scorer.
 *
 * A **read-only observer**. `observe()` returns `void` synchronously, defers all
 * work to a later event-loop turn via `setImmediate`, and can never throw: a
 * scoring failure must not fail, slow, or alter a user's run. Nothing in this
 * module writes to a user-visible path.
 *
 * Order of gates, all of them BEFORE any judge call:
 *   1. `ONLINE_EVAL_ENABLED` kill switch (default OFF)
 *   2. candidate has both a question and an answer
 *   3. sampling decision at `ONLINE_EVAL_SAMPLE_RATE` (default 1%)
 *   4. token budget reservation — its own allowance, never the analysis cap
 *   5. PII redaction of question / answer / contexts
 *   6. judge call
 *
 * The judge is reached only through the `RagasJudge` seam in
 * `server/src/lib/rag/ragas.ts`. Today the only implementation is
 * `StubRagasJudge`, whose lexical `faithfulness` does not measure faithfulness
 * (#1317). Windows scored by it carry `judgeMeaningful: false`, and a window
 * with `judgeMeaningful: false` can never raise a drift alert.
 *
 * That gate protects the row being **written**. The row it is **compared
 * against** needs its own gate: drift is only defined within one judge
 * implementation, so {@link selectBaselineWindow} picks the most recent
 * previous window produced by the *same* judge. Without it the first window
 * scored by a real judge would diff against a lexical-stub baseline and page an
 * operator at exactly the #1317 cutover moment.
 *
 * Live traffic has no ground-truth contexts and no reference answer, so
 * `context_precision` / `context_recall` are vacuous here for ANY judge. Only
 * the reference-free pair (`faithfulness`, `answer_relevancy`) is trended.
 *
 * ── UNVERIFIABLE IS NOT ZERO (#1329) ────────────────────────────────────────
 *
 * #1317 made every RAGAS metric `number | null`, where `null` means the judge
 * could not decide. Two consequences run through this module: the window mean
 * excludes nulls from BOTH the numerator and the denominator per metric (see
 * {@link aggregateScores}), and a window whose primary metric is `null` cannot
 * raise a drift alert (see {@link computeDrift}). Widening the judge type
 * without either of those would have turned a judge outage into a window of
 * confident `0.0` faithfulness and paged an operator over a regression that
 * never happened.
 */
import {
  ONLINE_EVAL_TRENDED_METRICS,
  type OnlineEvalBudgetState,
  type OnlineEvalDrift,
  type OnlineEvalSample,
  type OnlineEvalStatus,
  type OnlineEvalWindow,
  type OnlineEvalWindowSummary,
  type RagasJudgement,
  type RagasMetricKey,
} from "@metis/shared";
import { createChildLogger } from "../../logger.js";
import {
  averageScores,
  StubRagasJudge,
  type RagasAggregate,
  type RagasFixture,
} from "../../rag/ragas.js";
import {
  dispatchOnlineDriftAlert,
  type DriftAlertOptions,
  type DriftAlertOutcome,
} from "../domain/drift-alert.js";
import { OnlineEvalBudget } from "./budget.js";
import { resolveOnlineEvalConfig, type OnlineEvalConfig } from "./config.js";
import { digest, redactCandidate, type LiveRunCandidate } from "./redact.js";
import { loadAllWindows, readPending, writePending, writeWindow } from "./store.js";

const log = createChildLogger("eval/online");

/**
 * Forward-compatible judge shape, on BOTH axes (#1329).
 *
 * *Async*: `StubRagasJudge.scoreFixture` is synchronous; `ModelRagasJudge`
 * (#1317) awaits a provider. Accepting either means the scorer picks up a
 * model-backed judge without a change here.
 *
 * *Nullable*: #1317 also made every metric `number | null`, where `null` means
 * the judge could not decide — UNVERIFIABLE, not a zero. The original
 * declaration named only the async axis and pinned `RagasScores`, which made
 * `StubRagasJudge` un-assignable the moment #1317 landed. Widening the type is
 * only half the fix; see {@link aggregateScores} for the half that matters.
 */
export interface OnlineJudge {
  scoreFixture(f: RagasFixture): RagasJudgement | Promise<RagasJudgement>;
}

/** The metric drift is measured on. */
export const PRIMARY_METRIC: RagasMetricKey = "faithfulness";

/**
 * Ceiling on concurrent judge calls. The monthly budget bounds total spend but
 * says nothing about a burst: without this, a traffic spike at a high sample
 * rate could put an unbounded number of judge calls in flight against a shared
 * upstream. Excess candidates are dropped, never queued — this is a sampler,
 * and a dropped sample costs nothing.
 */
export const MAX_INFLIGHT_SCORES = 4;

export type SkipReason =
  | "DISABLED"
  | "EMPTY_CANDIDATE"
  | "NOT_SAMPLED"
  | "NO_BUDGET_CONFIGURED"
  | "MONTHLY_BUDGET_EXCEEDED"
  | "TOO_MANY_INFLIGHT"
  | "JUDGE_ERROR"
  | "STORE_ERROR";

export interface ObserveOutcome {
  scored: boolean;
  reason: "OK" | SkipReason;
  sample?: OnlineEvalSample;
  /** Set when this sample completed a window. */
  window?: OnlineEvalWindow;
  alert?: DriftAlertOutcome;
}

export interface OnlineEvalScorerDeps {
  /** Resolved per call so an admin config change takes effect immediately. */
  config?: () => OnlineEvalConfig;
  judge?: OnlineJudge;
  budget?: OnlineEvalBudget;
  /** [0,1) sampling source. */
  random?: () => number;
  now?: () => Date;
  /** Alert transport seam (defaults to the domain-eval drift dispatcher). */
  dispatchAlert?: (
    w: OnlineEvalWindowSummary,
    opts?: DriftAlertOptions,
  ) => Promise<DriftAlertOutcome>;
  /** Deferral seam — tests can run work inline. */
  defer?: (fn: () => void) => void;
}

/** Name + trustworthiness of a judge implementation. */
export function describeJudge(judge: OnlineJudge): { name: string; meaningful: boolean } {
  const explicit = (judge as { judgeName?: string }).judgeName;
  const name = explicit ?? judge.constructor?.name ?? "UnknownJudge";
  // Anything called `Stub*` is a lexical placeholder, not a judge (#1317).
  return { name, meaningful: !/^Stub/.test(name) };
}

/** Rough token cost of one judge call, used to settle the reservation. */
export function estimateJudgeTokens(chars: number): number {
  return Math.ceil(chars / 4) + 200;
}

/**
 * Window mean, EXCLUDING unverifiable metrics from both the numerator and the
 * denominator, per metric (#1329).
 *
 * This delegates to {@link averageScores} rather than re-implementing the rule:
 * "how do you average a judgement that may be UNVERIFIABLE" already has one
 * answer in this codebase (`server/src/lib/rag/ragas.ts`, #1317) and a second
 * convention for the same idea is how the two drift apart.
 *
 * The predecessor summed into a zero-initialised accumulator and divided by
 * `list.length`. Once #1317 made the metrics nullable that was actively
 * dangerous: `0 + null === 0` in JavaScript, so a window the judge could not
 * score would have read as a confident **0.0** on `faithfulness` — the metric
 * drift alerts fire on — and manufactured a regression out of a judge outage.
 * A metric nothing in the window scored is `null`.
 */
export function aggregateScores(list: readonly RagasJudgement[]): RagasAggregate {
  return averageScores(list);
}

export interface DriftInput {
  /** `null` when the window could not be scored on this metric at all (#1329). */
  current: number | null;
  previous: number | null;
  thresholdPct: number;
  judgeMeaningful: boolean;
  metric?: RagasMetricKey;
  /**
   * True when windows exist but none were produced by the current judge, so
   * `previous` is null for a reason worth distinguishing from "first window
   * ever" — this is what the #1317 cutover looks like.
   */
  incomparableHistory?: boolean;
  /**
   * True when a same-judge baseline window exists but was itself UNVERIFIABLE
   * on this metric, so `previous` is null for a third distinct reason (#1329).
   */
  baselineUnverifiable?: boolean;
}

/**
 * Most recent previous window that is a valid drift baseline for `judge`.
 *
 * Comparison is only defined within one judge implementation. A stub score and
 * a model score are different measurements of different things, so a window
 * scored by judge A must never be diffed against one scored by judge B — in
 * either direction.
 */
export function selectBaselineWindow(
  windows: readonly OnlineEvalWindow[],
  judge: string,
): OnlineEvalWindow | null {
  // `loadAllWindows` returns newest first, so the first match is the latest.
  return windows.find((w) => w.judge === judge) ?? null;
}

/**
 * Window-over-window drift on the primary metric.
 *
 * `alert` requires a real judge: a stub score is a lexical heuristic, and
 * alerting on its movement would page an operator over noise (#1317).
 *
 * It also requires a metric that was actually measured (#1329). An UNVERIFIABLE
 * window has no value to diff — not a low one — so it reports
 * `UNVERIFIABLE_METRIC` and starts no comparison. This gate is what makes a
 * judge outage read as "we could not measure" rather than as a total
 * collapse of the primary metric.
 */
export function computeDrift(input: DriftInput): OnlineEvalDrift {
  const metric = input.metric ?? PRIMARY_METRIC;
  // FIRST gate: nothing in this window was scorable on `metric`. Checked ahead
  // of the baseline branches because it is the more actionable fact — it names
  // a judge outage, where "no previous window" only names a cold start.
  if (input.current == null) {
    return {
      metric,
      previous: input.previous,
      delta: null,
      thresholdPct: input.thresholdPct,
      alert: false,
      reason: "UNVERIFIABLE_METRIC",
    };
  }
  if (input.previous == null) {
    return {
      metric,
      previous: null,
      delta: null,
      thresholdPct: input.thresholdPct,
      alert: false,
      reason: input.baselineUnverifiable
        ? "BASELINE_UNVERIFIABLE"
        : input.incomparableHistory
          ? "NO_COMPARABLE_BASELINE"
          : "NO_PREVIOUS_WINDOW",
    };
  }
  const delta = input.current - input.previous;
  const breached = delta < -input.thresholdPct;
  if (!breached) {
    return {
      metric,
      previous: input.previous,
      delta,
      thresholdPct: input.thresholdPct,
      alert: false,
      reason: "WITHIN_THRESHOLD",
    };
  }
  if (!input.judgeMeaningful) {
    return {
      metric,
      previous: input.previous,
      delta,
      thresholdPct: input.thresholdPct,
      alert: false,
      reason: "SUPPRESSED_STUB_JUDGE",
    };
  }
  return {
    metric,
    previous: input.previous,
    delta,
    thresholdPct: input.thresholdPct,
    alert: true,
    reason: "DRIFT",
  };
}

let sampleCounter = 0;
function nextSampleId(now: Date): string {
  sampleCounter = (sampleCounter + 1) % 1_000_000;
  return `s-${now.getTime().toString(36)}-${sampleCounter.toString(36)}`;
}

export class OnlineEvalScorer {
  private readonly configFn: () => OnlineEvalConfig;
  private readonly judge: OnlineJudge;
  private readonly randomFn: () => number;
  private readonly nowFn: () => Date;
  private readonly deferFn: (fn: () => void) => void;
  private readonly dispatchAlertFn: (
    w: OnlineEvalWindowSummary,
    opts?: DriftAlertOptions,
  ) => Promise<DriftAlertOutcome>;
  private budgetInstance: OnlineEvalBudget | null;
  private readonly inflight = new Set<Promise<void>>();
  /** Judge calls currently outstanding (see {@link MAX_INFLIGHT_SCORES}). */
  private activeScores = 0;
  /** Serialises the pending-sample read-modify-write. */
  private storeQueue: Promise<unknown> = Promise.resolve();

  constructor(deps: OnlineEvalScorerDeps = {}) {
    this.configFn = deps.config ?? (() => resolveOnlineEvalConfig());
    this.judge = deps.judge ?? new StubRagasJudge();
    this.randomFn = deps.random ?? Math.random;
    this.nowFn = deps.now ?? (() => new Date());
    this.deferFn = deps.defer ?? ((fn) => void setImmediate(fn));
    this.dispatchAlertFn = deps.dispatchAlert ?? dispatchOnlineDriftAlert;
    this.budgetInstance = deps.budget ?? null;
  }

  private budget(): OnlineEvalBudget {
    if (!this.budgetInstance) {
      this.budgetInstance = new OnlineEvalBudget({
        // Thunk, not a snapshot: windows re-resolve `resultsDir` per call and
        // the ledger has to follow it.
        dir: () => this.configFn().resultsDir,
        cap: () => this.configFn().monthlyTokenBudget,
        now: this.nowFn,
      });
    }
    return this.budgetInstance;
  }

  /**
   * Fire-and-forget entry point. Returns immediately, does no work in the
   * caller's tick, and never throws. Callers MUST NOT await anything here.
   */
  observe(candidate: LiveRunCandidate): void {
    let settle: () => void = () => undefined;
    const tracked = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.inflight.add(tracked);
    this.deferFn(() => {
      void this.score(candidate)
        .catch((err) => {
          // Unreachable — score() swallows everything. Belt and braces.
          log.debug("online eval observer failed", { error: (err as Error).message });
        })
        .finally(() => {
          this.inflight.delete(tracked);
          settle();
        });
    });
  }

  /**
   * Cheap synchronous "is anything going to happen?" probe.
   *
   * Callers use it to skip the bookkeeping a candidate needs (accumulating a
   * streamed answer, capturing RAG contexts) while the feature is OFF, which is
   * the default. `observe()` re-checks the same flag, so this is an
   * optimisation and never the only gate. Never throws.
   */
  enabled(): boolean {
    try {
      return this.configFn().enabled;
    } catch {
      return false;
    }
  }

  /** Await all deferred scoring work. Test / shutdown seam. */
  async drain(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.all([...this.inflight]);
    }
  }

  /**
   * The scoring path. Exposed for tests; production callers use
   * {@link observe}. Resolves with an outcome and never rejects.
   */
  async score(candidate: LiveRunCandidate): Promise<ObserveOutcome> {
    try {
      const cfg = this.configFn();
      if (!cfg.enabled) return { scored: false, reason: "DISABLED" };
      if (!candidate.question?.trim() || !candidate.answer?.trim()) {
        return { scored: false, reason: "EMPTY_CANDIDATE" };
      }
      if (cfg.sampleRate <= 0 || this.randomFn() >= cfg.sampleRate) {
        return { scored: false, reason: "NOT_SAMPLED" };
      }

      if (this.activeScores >= MAX_INFLIGHT_SCORES) {
        return { scored: false, reason: "TOO_MANY_INFLIGHT" };
      }

      // Budget FIRST — a judge call that is not reserved never happens.
      const decision = await this.budget().reserve(cfg.tokensPerScore);
      if (!decision.allowed) {
        return { scored: false, reason: decision.reason as SkipReason };
      }

      const redacted = redactCandidate(candidate, cfg.maxChars);
      const fixture: RagasFixture = {
        id: `online-${candidate.surface}`,
        question: redacted.question,
        // Live traffic has neither ground-truth spans nor reference keywords.
        groundTruthContexts: [],
        expectedAnswerKeywords: [],
        generatedAnswer: redacted.answer,
        retrievedChunks: redacted.contexts,
      };

      let scores: RagasJudgement;
      const charCount =
        redacted.question.length +
        redacted.answer.length +
        redacted.contexts.reduce((n, c) => n + c.length, 0);
      try {
        this.activeScores += 1;
        scores = await this.judge.scoreFixture(fixture);
      } catch (err) {
        // Refund the reservation: no call was completed, so `calls` walks back
        // too — the operator counter reports completions, not attempts.
        await this.budget().refund(decision.reserved);
        log.debug("online eval judge failed", { error: (err as Error).message });
        return { scored: false, reason: "JUDGE_ERROR" };
      } finally {
        this.activeScores = Math.max(0, this.activeScores - 1);
      }
      await this.budget().settle(decision.reserved, estimateJudgeTokens(charCount));

      const now = this.nowFn();
      const sample: OnlineEvalSample = {
        sampleId: nextSampleId(now),
        surface: candidate.surface,
        observedAt: now.toISOString(),
        questionHash: digest(redacted.question),
        answerHash: digest(redacted.answer),
        questionChars: redacted.question.length,
        answerChars: redacted.answer.length,
        contextCount: redacted.contexts.length,
        contextChars: redacted.contexts.reduce((n, c) => n + c.length, 0),
        redactionHits: redacted.redactionHits,
        scores,
        tokensCharged: estimateJudgeTokens(charCount),
      };

      try {
        const flushed = await this.appendSample(cfg, sample);
        return { scored: true, reason: "OK", sample, ...flushed };
      } catch (err) {
        log.debug("online eval store failed", { error: (err as Error).message });
        return { scored: false, reason: "STORE_ERROR", sample };
      }
    } catch (err) {
      log.debug("online eval scoring failed", { error: (err as Error).message });
      return { scored: false, reason: "STORE_ERROR" };
    }
  }

  /** Append to the pending buffer, flushing a window when it is full. */
  private appendSample(
    cfg: OnlineEvalConfig,
    sample: OnlineEvalSample,
  ): Promise<{ window?: OnlineEvalWindow; alert?: DriftAlertOutcome }> {
    return this.enqueue(async () => {
      const pending = [...(await readPending(cfg.resultsDir)), sample];
      if (pending.length < cfg.windowSize) {
        await writePending(cfg.resultsDir, pending);
        return {};
      }
      const built = await this.buildWindow(cfg, pending);
      await writeWindow(cfg.resultsDir, built.window);
      // Only clear the buffer once the window is durably on disk.
      await writePending(cfg.resultsDir, []);
      const alert = await this.maybeAlert(cfg, built.summary);
      return { window: built.window, alert };
    });
  }

  private async buildWindow(
    cfg: OnlineEvalConfig,
    samples: OnlineEvalSample[],
  ): Promise<{ window: OnlineEvalWindow; summary: OnlineEvalWindowSummary }> {
    const { name, meaningful } = describeJudge(this.judge);
    const { mean, scored, unverifiable } = aggregateScores(samples.map((s) => s.scores));
    const previousWindows = await loadAllWindows(cfg.resultsDir);
    // Same-judge baseline only — see `selectBaselineWindow`.
    const baseline = selectBaselineWindow(previousWindows, name);
    const previous = baseline ? baseline.meanScores[PRIMARY_METRIC] : null;
    const drift = computeDrift({
      current: mean[PRIMARY_METRIC],
      previous,
      thresholdPct: cfg.driftThresholdPct,
      judgeMeaningful: meaningful,
      incomparableHistory: baseline === null && previousWindows.length > 0,
      baselineUnverifiable: baseline !== null && previous === null,
    });
    const budgetState: OnlineEvalBudgetState = await this.budget().status();
    const completedAt = this.nowFn().toISOString();
    const window: OnlineEvalWindow = {
      windowId: `online-${completedAt.replace(/[:.]/g, "-")}`,
      schemaVersion: 1,
      startedAt: samples[0]?.observedAt ?? completedAt,
      completedAt,
      judge: name,
      judgeMeaningful: meaningful,
      sampleCount: samples.length,
      meanScores: mean,
      // How much of the window was actually measured, per metric. A mean of
      // 0.95 over 2 of 20 samples is a different fact from 0.95 over 20, and
      // without these counts an operator cannot tell them apart (#1317/#1329).
      scored,
      unverifiable,
      trendedMetrics: [...ONLINE_EVAL_TRENDED_METRICS],
      drift,
      budget: budgetState,
      samples,
    };
    const { samples: _drop, ...summaryBase } = window;
    return { window, summary: { ...summaryBase, driftAlert: drift.alert } };
  }

  private async maybeAlert(
    cfg: OnlineEvalConfig,
    summary: OnlineEvalWindowSummary,
  ): Promise<DriftAlertOutcome | undefined> {
    // Three independent gates. `dispatchOnlineDriftAlert` also short-circuits on
    // `!drift.alert`, but the decision belongs here too: a caller that injects
    // its own transport must not be handed a no-drift window to send.
    if (!summary.drift.alert) return undefined;
    if (!cfg.driftAlertsEnabled) return undefined;
    if (!summary.judgeMeaningful) return undefined;
    try {
      return await this.dispatchAlertFn(summary);
    } catch (err) {
      log.debug("online eval alert failed", { error: (err as Error).message });
      return undefined;
    }
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.storeQueue.then(fn, fn);
    this.storeQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** Operator status — config, judge honesty marker, budget and buffer depth. */
  async status(): Promise<OnlineEvalStatus> {
    const cfg = this.configFn();
    const { name, meaningful } = describeJudge(this.judge);
    const pending = await readPending(cfg.resultsDir);
    return {
      enabled: cfg.enabled,
      sampleRate: cfg.sampleRate,
      windowSize: cfg.windowSize,
      driftAlertsEnabled: cfg.driftAlertsEnabled,
      judge: name,
      judgeMeaningful: meaningful,
      pendingSamples: pending.length,
      budget: await this.budget().status(),
    };
  }
}

let singleton: OnlineEvalScorer | null = null;

export function getOnlineEvalScorer(): OnlineEvalScorer {
  if (!singleton) singleton = new OnlineEvalScorer();
  return singleton;
}

/** Test seam. */
export function __setOnlineEvalScorer(next: OnlineEvalScorer | null): void {
  singleton = next;
}
