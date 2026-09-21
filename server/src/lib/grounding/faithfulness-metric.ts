/**
 * Epic #1316 (#1317/#1318) — the ONE claim-level faithfulness metric.
 *
 * METIS had two verification stacks that never met. `docs-gen` decomposed a
 * section into atomic claims and asked an NLI judge whether each was entailed by
 * the retrieved evidence (`scoreFaithfulness`); `analysis` ran a deterministic
 * citation gate plus a categorical LLM support panel and produced no number at
 * all. "How grounded is METIS output?" therefore had no single answer, and a
 * regression in one pipeline was invisible to the other's gate.
 *
 * This module is the neutral home for that one metric. It does NOT introduce a
 * second judging stack: it wraps the existing claim-extraction +
 * {@link FaithfulnessJudge} substrate and normalises its result into a shape both
 * pipelines — and the `RagasJudge` seam (#1317) — report identically.
 *
 * ── WHY `faithfulness` IS NULLABLE HERE AND NOT IN `FaithfulnessResult` ─────
 *
 * `FaithfulnessResult.faithfulness` is `1` in three quite different situations:
 * the judge verified every claim; the judge could not run at all; and there were
 * no claims to judge. docs-gen conflates them deliberately — it compares against
 * a threshold and `1` is the value that cannot produce a FALSE `degraded`.
 *
 * A *metric* cannot afford that conflation. Averaging "unverifiable" as 1.0 is
 * vacuous truth: it moves the mean up in exactly the runs where the system knew
 * least, which is the defect #1317 calls out in `StubRagasJudge`. So
 * {@link toFaithfulnessMetric} maps both unverifiable shapes to `null` and
 * {@link meanFaithfulness} EXCLUDES nulls from the denominator rather than
 * counting them as passes. Callers that need the pass-through semantics keep
 * reading `FaithfulnessResult` directly; nothing about docs-gen's gate changes.
 */
import {
  buildGroundingContext,
  type GroundingContext,
} from "../docs-gen/grounding/grounding-context.js";
import {
  scoreFaithfulness,
  type FaithfulnessResult,
  type ScoreFaithfulnessDeps,
} from "../docs-gen/grounding/citation-validator.js";

/** Why a {@link FaithfulnessMetric} carries `null` instead of a number. */
export type UnverifiableReason =
  /** There was no retrieved evidence to judge the text against. */
  | "no-evidence"
  /** The text decomposed into zero atomic claims — nothing to score. */
  | "no-claims"
  /** The judge could not return a usable verdict (offline, parse failure). */
  | "judge-unavailable";

/**
 * One text's claim-level faithfulness, reported identically by every pipeline.
 *
 * `faithfulness === null` means UNVERIFIABLE — never "bad" and never "good". It
 * is excluded from aggregates by {@link meanFaithfulness}.
 */
export interface FaithfulnessMetric {
  /** supported/total in [0,1], or `null` when unverifiable. */
  faithfulness: number | null;
  totalClaims: number;
  supportedClaims: number;
  /** Present iff {@link faithfulness} is `null`. */
  unverifiableReason?: UnverifiableReason;
}

/** One retrieved excerpt, in the neutral shape both pipelines can produce. */
export interface FaithfulnessEvidence {
  /** Stable locator — a file path, chunk id, or document anchor. */
  id: string;
  /** Short human label carried into the judge prompt for attribution. */
  label?: string;
  /** The evidence text. UNTRUSTED — the judge prompt frames it as data. */
  text: string;
}

/** An unverifiable metric with no claims counted. */
export function unverifiableMetric(reason: UnverifiableReason): FaithfulnessMetric {
  return { faithfulness: null, totalClaims: 0, supportedClaims: 0, unverifiableReason: reason };
}

/**
 * Normalise a docs-gen {@link FaithfulnessResult} into the shared metric.
 *
 * Two distinct 1.0s become `null`:
 *   - `verified === false` → `judge-unavailable` (offline / parse / no context)
 *   - `totalClaims === 0`  → `no-claims` (vacuous truth: nothing was checked)
 *
 * Everything else is the real supported/total ratio.
 */
export function toFaithfulnessMetric(result: FaithfulnessResult): FaithfulnessMetric {
  if (!result.verified) {
    return {
      faithfulness: null,
      totalClaims: result.totalClaims,
      supportedClaims: 0,
      unverifiableReason: "judge-unavailable",
    };
  }
  if (result.totalClaims === 0) return unverifiableMetric("no-claims");
  return {
    faithfulness: result.supportedClaims / result.totalClaims,
    totalClaims: result.totalClaims,
    supportedClaims: result.supportedClaims,
  };
}

/** Aggregate of a set of {@link FaithfulnessMetric}s. */
export interface FaithfulnessAggregate {
  /** Mean over the SCORED items only, or `null` when nothing was scored. */
  mean: number | null;
  /** How many items produced a number. */
  scored: number;
  /** How many items were unverifiable and therefore excluded from {@link mean}. */
  unverifiable: number;
  /** Total supported claims across scored items. */
  supportedClaims: number;
  /** Total claims across scored items. */
  totalClaims: number;
}

/**
 * Mean faithfulness over the items that were actually scored.
 *
 * Unverifiable items are EXCLUDED from the denominator, not counted as 1.0.
 * The count is reported so a reader can see how much of the run was verifiable —
 * a mean of 0.95 over 2 of 40 items is a different fact from 0.95 over 40.
 */
export function meanFaithfulness(metrics: readonly FaithfulnessMetric[]): FaithfulnessAggregate {
  let sum = 0;
  let scored = 0;
  let unverifiable = 0;
  let supportedClaims = 0;
  let totalClaims = 0;
  for (const m of metrics) {
    if (m.faithfulness === null) {
      unverifiable += 1;
      continue;
    }
    sum += m.faithfulness;
    scored += 1;
    supportedClaims += m.supportedClaims;
    totalClaims += m.totalClaims;
  }
  return {
    mean: scored === 0 ? null : sum / scored,
    scored,
    unverifiable,
    supportedClaims,
    totalClaims,
  };
}

/** Default char budget for an evidence bundle assembled by {@link evidenceContext}. */
export const DEFAULT_EVIDENCE_CHAR_BUDGET = 60_000;

/**
 * Assemble neutral evidence into the {@link GroundingContext} the existing
 * claim-extraction + judge substrate expects, reusing `buildGroundingContext`'s
 * de-duplication and char budgeting rather than re-implementing them.
 *
 * Each item is admitted as a `rag:` source keyed by its locator, so the judge's
 * optional `sourceIds` attribution points back at something the caller can
 * resolve (a file path, a `report.md#chunk-13`).
 */
export function evidenceContext(
  evidence: readonly FaithfulnessEvidence[],
  charBudget = DEFAULT_EVIDENCE_CHAR_BUDGET,
): GroundingContext {
  return buildGroundingContext({
    ragChunks: evidence.map((e, i) => ({
      documentId: e.id || `evidence-${i}`,
      chunkId: String(i),
      ...(e.label ? { filename: e.label } : {}),
      text: e.text,
    })),
    charBudget,
  });
}

/**
 * Score one text's faithfulness against neutral evidence.
 *
 * This is the single entry point both pipelines call. It delegates to
 * `scoreFaithfulness` — the SAME decomposition and NLI judge docs-gen has used
 * since #273 — and only normalises the result, so the two pipelines cannot drift
 * into measuring different things under one name.
 */
export async function scoreEvidenceFaithfulness(
  label: string,
  text: string,
  evidence: readonly FaithfulnessEvidence[],
  deps: ScoreFaithfulnessDeps & { charBudget?: number },
): Promise<FaithfulnessMetric> {
  if (!text.trim()) return unverifiableMetric("no-claims");
  const ctx = evidenceContext(evidence, deps.charBudget ?? DEFAULT_EVIDENCE_CHAR_BUDGET);
  if (ctx.isEmpty) return unverifiableMetric("no-evidence");
  const result = await scoreFaithfulness(label, text, ctx, deps);
  return toFaithfulnessMetric(result);
}
