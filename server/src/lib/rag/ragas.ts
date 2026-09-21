/**
 * Epic #157 — RAGAS evaluation harness (issue #103), reopened by #1317.
 *
 * Computes the four canonical RAGAS metrics over a curated golden set of
 * `(question, ground_truth_contexts, answer_or_expected)` fixtures:
 *
 *   - context_precision  — fraction of retrieved chunks that the judge
 *     deems relevant to the question.
 *   - context_recall     — fraction of ground-truth contexts that appear
 *     in retrieval.
 *   - faithfulness       — answer is supported by retrieved contexts.
 *   - answer_relevancy   — answer addresses the question.
 *
 * ── TWO JUDGES BEHIND ONE SEAM (#1317) ──────────────────────────────────────
 *
 * {@link StubRagasJudge} is the DEFAULT and stays deterministic, offline and
 * free, so CI never spends a token. `ModelRagasJudge` (`model-ragas-judge.ts`)
 * is opt-in via `RAGAS_JUDGE=model` plus an injected provider; it delegates to
 * the SAME claim-extraction + `FaithfulnessJudge` substrate docs-gen has used
 * since #273 rather than standing up a second judging stack.
 *
 * ── WHAT #1317 CHANGED IN THE STUB ──────────────────────────────────────────
 *
 * Every metric used to fall back to `1.0` when its denominator was zero. That
 * is vacuous truth, and for `faithfulness` it was worse than vacuous: the metric
 * only ever inspected `expectedAnswerKeywords`, so an answer that invented a
 * claim outside the keyword list scored a perfect 1.0. Zero-denominator cases
 * now return `null` — UNVERIFIABLE — and {@link averageScores} excludes them
 * from the mean instead of counting them as passes. The per-metric `scored` /
 * `unverifiable` counts travel with the result so a reader can see how much of
 * the run was actually measured.
 *
 * The harness is invoked by `server/scripts/rag-eval.ts` which writes
 * `coverage/ragas-results.json`. CI compares the result against a baseline
 * artifact from the latest `main` run.
 */
import { createHash } from "node:crypto";
import {
  ragasMetricKeys,
  type RagasCoverage,
  type RagasJudgement,
  type RagasMetricKey,
  type RagasResult,
} from "@metis/shared";

export type { RagasJudgement, RagasCoverage } from "@metis/shared";

export interface RagasFixture {
  id: string;
  question: string;
  /** Substrings that MUST appear in the retrieved chunk text. */
  groundTruthContexts: string[];
  /** Keywords/phrases the answer should mention. */
  expectedAnswerKeywords: string[];
  /** Optional canned answer to score for faithfulness/relevancy. */
  generatedAnswer?: string;
  /** Optional canned retrieval result; lets the harness be self-contained. */
  retrievedChunks?: string[];
}

/**
 * A judge scores one fixture into four metric values, each of which may be
 * `null` when this judge cannot decide it for this fixture.
 *
 * The return type is `RagasJudgement | Promise<RagasJudgement>` so the free
 * deterministic stub stays synchronous while a model-backed judge can await its
 * provider. Call sites go through {@link scoreFixtures}, which awaits either.
 */
export interface RagasJudge {
  scoreFixture(f: RagasFixture): RagasJudgement | Promise<RagasJudgement>;
}

/**
 * Deterministic stub judge — only string membership + simple heuristics.
 * Behavior:
 *   - context_precision = |relevant retrieved| / |retrieved|
 *   - context_recall   = |ground-truth seen in retrieval| / |ground-truth|
 *   - faithfulness     = fraction of matched answer keywords also in retrieval
 *   - answer_relevancy = fraction of expected keywords present in generatedAnswer
 *
 * A metric whose denominator is zero is `null` (UNVERIFIABLE), never `1`. See
 * the module doc: the old vacuous-truth fallback is the defect #1317 exists to
 * remove, and it is why this judge could report a perfect faithfulness for an
 * answer it had not checked a single claim of.
 *
 * This judge remains the DEFAULT so `pnpm rag:eval` and CI stay hermetic.
 */
export class StubRagasJudge implements RagasJudge {
  scoreFixture(f: RagasFixture): RagasJudgement {
    const retrieved = f.retrievedChunks ?? [];
    const truth = f.groundTruthContexts ?? [];
    const expected = f.expectedAnswerKeywords ?? [];
    const answer = (f.generatedAnswer ?? "").toLowerCase();

    let relevantRetrieved = 0;
    for (const r of retrieved) {
      if (truth.some((g) => r.toLowerCase().includes(g.toLowerCase()))) {
        relevantRetrieved += 1;
      }
    }
    const context_precision = retrieved.length === 0 ? null : relevantRetrieved / retrieved.length;

    let truthSeen = 0;
    for (const g of truth) {
      if (retrieved.some((r) => r.toLowerCase().includes(g.toLowerCase()))) {
        truthSeen += 1;
      }
    }
    const context_recall = truth.length === 0 ? null : truthSeen / truth.length;

    let answerInRetrieval = 0;
    const answerWords = expected.filter((k) => answer.includes(k.toLowerCase()));
    for (const k of answerWords) {
      if (retrieved.some((r) => r.toLowerCase().includes(k.toLowerCase()))) {
        answerInRetrieval += 1;
      }
    }
    const faithfulness = answerWords.length === 0 ? null : answerInRetrieval / answerWords.length;

    let keywordsHit = 0;
    for (const k of expected) {
      if (answer.includes(k.toLowerCase())) keywordsHit += 1;
    }
    const answer_relevancy = expected.length === 0 ? null : keywordsHit / expected.length;

    return { context_precision, context_recall, faithfulness, answer_relevancy };
  }
}

/** Zeroed per-metric counter. */
function zeroCoverage(): RagasCoverage {
  return {
    context_precision: 0,
    context_recall: 0,
    faithfulness: 0,
    answer_relevancy: 0,
  };
}

/** Aggregate of a set of judgements, with per-metric verifiability counts. */
export interface RagasAggregate {
  /** Mean over the SCORED fixtures only; `null` for a metric nothing scored. */
  mean: RagasJudgement;
  /** How many fixtures produced a number for each metric. */
  scored: RagasCoverage;
  /** How many fixtures were UNVERIFIABLE for each metric (excluded from the mean). */
  unverifiable: RagasCoverage;
}

/**
 * Average a list of judgements, EXCLUDING unverifiable values from both the
 * numerator and the denominator.
 *
 * The alternative — treating `null` as 1.0 — inflates the aggregate in exactly
 * the fixtures the judge understood least, which is how a lexical stub reported
 * a healthy faithfulness while checking no claims at all.
 */
export function averageScores(scoresList: readonly RagasJudgement[]): RagasAggregate {
  const sum = zeroCoverage() as Record<RagasMetricKey, number>;
  const scored = zeroCoverage();
  const unverifiable = zeroCoverage();
  for (const s of scoresList) {
    for (const k of ragasMetricKeys) {
      const v = s[k];
      if (v === null || v === undefined || Number.isNaN(v)) {
        unverifiable[k] += 1;
        continue;
      }
      sum[k] += v;
      scored[k] += 1;
    }
  }
  const mean = {} as RagasJudgement;
  for (const k of ragasMetricKeys) {
    mean[k] = scored[k] === 0 ? null : sum[k] / scored[k];
  }
  return { mean, scored, unverifiable };
}

/**
 * Score every fixture with `judge`, awaiting a model-backed judge and passing a
 * synchronous stub straight through. Fixtures are scored SEQUENTIALLY: a model
 * judge makes several provider calls per fixture, and a 40-fixture golden set
 * fanned out at once is a thundering herd, not a speed-up.
 */
export async function scoreFixtures(
  fixtures: readonly RagasFixture[],
  judge: RagasJudge,
): Promise<RagasJudgement[]> {
  const out: RagasJudgement[] = [];
  for (const f of fixtures) out.push(await judge.scoreFixture(f));
  return out;
}

export function computeDeltas(
  baseline: RagasJudgement | null,
  current: RagasJudgement,
): { deltas: RagasJudgement | null; regressions: RagasResult["regressions"] } {
  if (!baseline) return { deltas: null, regressions: [] };
  const deltas = {} as RagasJudgement;
  const regressions: RagasResult["regressions"] = [];
  for (const k of ragasMetricKeys) {
    const b = baseline[k];
    const c = current[k];
    // An unverifiable metric on EITHER side has no delta. Coercing a null to 0
    // would manufacture a -1.0 "regression" out of a run that simply could not
    // measure the metric, and a coercion to 1 would hide a real drop.
    if (b === null || b === undefined || c === null || c === undefined) {
      deltas[k] = null;
      continue;
    }
    const delta = c - b;
    deltas[k] = delta;
    if (delta < -REGRESSION_THRESHOLD) {
      regressions.push({
        metric: k as RagasMetricKey,
        baseline: b,
        current: c,
        delta,
      });
    }
  }
  return { deltas, regressions };
}

/** Default regression threshold — 5pp drop on any metric counts as a regression. */
export const REGRESSION_THRESHOLD = 0.05;

/** Run the full eval over `fixtures` with a `judge` and return the report. */
export async function runEval(input: {
  fixtures: RagasFixture[];
  judge?: RagasJudge;
  baseline?: RagasJudgement | null;
}): Promise<RagasResult> {
  const judge = input.judge ?? new StubRagasJudge();
  const perFixture = await scoreFixtures(input.fixtures, judge);
  const { mean, scored, unverifiable } = averageScores(perFixture);
  const { deltas, regressions } = computeDeltas(input.baseline ?? null, mean);
  return {
    baseline: input.baseline ?? null,
    current: mean,
    deltas,
    regressions,
    fixtures: input.fixtures.length,
    scored,
    unverifiable,
  };
}

/** Stable digest of a fixture set — useful for caching results. */
export function fixtureSetDigest(fixtures: RagasFixture[]): string {
  const h = createHash("sha256");
  for (const f of fixtures) {
    h.update(f.id);
    h.update(f.question);
    for (const g of f.groundTruthContexts ?? []) h.update(g);
    for (const k of f.expectedAnswerKeywords ?? []) h.update(k);
    h.update(f.generatedAnswer ?? "");
  }
  return h.digest("hex").slice(0, 16);
}
