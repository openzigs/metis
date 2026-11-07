/**
 * #1867 — scoring a governing-rules arm against the ground truth.
 *
 * The scorer reads only {@link GoverningArmOutput}: the rules an arm says
 * apply, each with a verdict and an optional citation. It knows nothing about
 * how an arm got there, so a new arm needs no change here.
 *
 * | Metric | Definition |
 * |---|---|
 * | Applicability recall | applied ∩ truth / truth, overall and on the non-resembling pairs |
 * | Applicability precision | applied ∩ truth / applied |
 * | Citation accuracy | verified citations / citations given; verified = the excerpt is a verbatim substring of the cited rule's clause in the stored policy, and the cited rule is the judged rule |
 * | Citation coverage | citations given / rules applied (so an arm cannot score accuracy by never citing) |
 * | Verdict accuracy | truth pairs whose verdict the arm got right / truth pairs (a missed pair is wrong) |
 * | Hard errors | `compliant` on a pair whose truth is `gap` or `needs-ba-input`: a no-evidence outcome scored as compliant |
 * | Ask rate | rules applied with `needs-ba-input` / rules applied |
 *
 * Ratios are pooled over pairs (micro). The interval is a seeded bootstrap
 * over items, so it reproduces byte for byte.
 *
 * A requirement the arm failed on (it threw) is scored as an error, never as
 * a clean negative (#1900): its truth pairs are misses, and a negative item it
 * failed on is not counted clean.
 */
import { seededRandom } from "../localization/stats.js";
import type { GoverningCorpus, GoverningItem, GoverningVerdict } from "./corpus.js";

/** A citation: a clause excerpt and the rule it claims to come from. */
export interface GoverningCitation {
  ruleId: string;
  excerpt: string;
}

/** One rule an arm says applies to the requirement. */
export interface GoverningJudgement {
  ruleId: string;
  verdict: GoverningVerdict;
  citation?: GoverningCitation;
  businessFact?: string;
}

/** What an arm returns for one requirement. */
export interface GoverningArmOutput {
  judgements: GoverningJudgement[];
  /** What the arm did on the way (chunks retrieved, rules screened…); reported, never scored. */
  diagnostics?: Record<string, number>;
}

/**
 * #1900 — the metrics an arm fixes by construction, each with the reason: A0
 * judges every rule `gap`, so it can make no hard error and never asks. A bar
 * on such a metric cannot fail, so it is reported `n/a`, never as a pass.
 */
export type ByConstruction = Partial<Record<"hardErrors" | "askRate" | "citationAccuracy", string>>;

/** An excerpt shorter than this does not pin a clause, so it never verifies. */
export const MIN_EXCERPT_WORDS = 4;

function normalizeSpace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The excerpt without a leading rule marker (`**AC-01**`, `AC-01:`): the
 * marker is in the stored policy line but not in the clause it introduces.
 */
export function stripRuleMarker(excerpt: string): string {
  return normalizeSpace(excerpt.replace(/^\s*\**\s*[A-Z]{2}-\d{2}\s*\**\s*[:.—–-]?\s*/, ""));
}

/**
 * True when `citation` is a verbatim substring (whitespace aside) of the
 * clause of `judgedRuleId` in the stored policy, and names that rule.
 */
export function citationVerified(
  corpus: Pick<GoverningCorpus, "ruleById">,
  judgedRuleId: string,
  citation: GoverningCitation | undefined,
): boolean {
  if (!citation || citation.ruleId !== judgedRuleId) return false;
  const rule = corpus.ruleById.get(judgedRuleId);
  if (!rule) return false;
  const excerpt = stripRuleMarker(citation.excerpt);
  if (excerpt.split(" ").filter(Boolean).length < MIN_EXCERPT_WORDS) return false;
  return normalizeSpace(rule.clause).includes(excerpt);
}

/** One pair's outcome, kept so a report can say which pair failed. */
export interface PairOutcome {
  ruleId: string;
  /** The truth verdict, or null when the rule does not truly apply (a false positive). */
  truth: GoverningVerdict | null;
  /** The arm's verdict, or null when the arm missed the rule. */
  verdict: GoverningVerdict | null;
  nonResembling: boolean;
  cited: boolean;
  citationVerified: boolean;
  hardError: boolean;
}

/** The counts of one requirement under one arm and run. */
export interface ItemCounts {
  truth: number;
  applied: number;
  truePositives: number;
  nonResemblingTruth: number;
  nonResemblingFound: number;
  cited: number;
  citationsVerified: number;
  verdictCorrect: number;
  hardErrors: number;
  asked: number;
  /** 1 when the arm threw on this requirement, else 0. */
  failures: number;
}

export interface ItemScore extends ItemCounts {
  itemId: string;
  pairs: PairOutcome[];
}

/**
 * Score one requirement. A rule judged twice counts once (the first
 * judgement); a rule id the corpus does not have is a false positive. An
 * output carrying `error` is a requirement the arm failed on.
 */
export function scoreItem(
  corpus: Pick<GoverningCorpus, "ruleById">,
  item: Pick<GoverningItem, "id" | "applies">,
  output: GoverningArmOutput & { error?: string },
): ItemScore {
  const truth = new Map(item.applies.map((p) => [p.ruleId, p]));
  const judged = new Map<string, GoverningJudgement>();
  for (const j of output.judgements) if (!judged.has(j.ruleId)) judged.set(j.ruleId, j);
  const pairs: PairOutcome[] = [];
  const counts: ItemCounts = {
    truth: truth.size,
    applied: judged.size,
    truePositives: 0,
    nonResemblingTruth: 0,
    nonResemblingFound: 0,
    cited: 0,
    citationsVerified: 0,
    verdictCorrect: 0,
    hardErrors: 0,
    asked: 0,
    failures: output.error !== undefined ? 1 : 0,
  };
  for (const [ruleId, j] of judged) {
    const t = truth.get(ruleId);
    const verified = citationVerified(corpus, ruleId, j.citation);
    const hardError = j.verdict === "compliant" && t !== undefined && t.verdict !== "compliant";
    if (j.citation) counts.cited++;
    if (verified) counts.citationsVerified++;
    if (j.verdict === "needs-ba-input") counts.asked++;
    if (hardError) counts.hardErrors++;
    if (t) {
      counts.truePositives++;
      if (t.verdict === j.verdict) counts.verdictCorrect++;
    }
    pairs.push({
      ruleId,
      truth: t?.verdict ?? null,
      verdict: j.verdict,
      nonResembling: t?.nonResembling === true,
      cited: j.citation !== undefined,
      citationVerified: verified,
      hardError,
    });
  }
  for (const t of truth.values()) {
    if (t.nonResembling) {
      counts.nonResemblingTruth++;
      if (judged.has(t.ruleId)) counts.nonResemblingFound++;
    }
    if (!judged.has(t.ruleId)) {
      pairs.push({
        ruleId: t.ruleId,
        truth: t.verdict,
        verdict: null,
        nonResembling: t.nonResembling === true,
        cited: false,
        citationVerified: false,
        hardError: false,
      });
    }
  }
  return { itemId: item.id, pairs, ...counts };
}

/** The headline numbers; a ratio with an empty denominator is null, never 0. */
export interface GoverningMetrics {
  items: number;
  recall: number | null;
  nonResemblingRecall: number | null;
  precision: number | null;
  citationAccuracy: number | null;
  citationCoverage: number | null;
  verdictAccuracy: number | null;
  askRate: number | null;
  hardErrors: number;
  /** Negative items (no rule applies) on which the arm ran and applied nothing. */
  cleanNegatives: number;
  negatives: number;
}

/** Each metric's numerator and denominator, from the counts. */
const RATIOS: Record<
  Exclude<keyof GoverningMetrics, "items" | "hardErrors" | "cleanNegatives" | "negatives">,
  [keyof ItemCounts, keyof ItemCounts]
> = {
  recall: ["truePositives", "truth"],
  nonResemblingRecall: ["nonResemblingFound", "nonResemblingTruth"],
  precision: ["truePositives", "applied"],
  citationAccuracy: ["citationsVerified", "cited"],
  citationCoverage: ["cited", "applied"],
  verdictAccuracy: ["verdictCorrect", "truth"],
  askRate: ["asked", "applied"],
};

export type RatioMetric = keyof typeof RATIOS;
export const RATIO_METRICS = Object.keys(RATIOS) as RatioMetric[];

function sum(scores: readonly ItemCounts[], key: keyof ItemCounts): number {
  return scores.reduce((n, s) => n + s[key], 0);
}

function ratio(num: number, den: number): number | null {
  return den === 0 ? null : num / den;
}

/** Pool one run's item scores. */
export function aggregate(scores: readonly ItemCounts[]): GoverningMetrics {
  const negatives = scores.filter((s) => s.truth === 0);
  const out = {
    items: scores.length,
    hardErrors: sum(scores, "hardErrors"),
    negatives: negatives.length,
    // A crash applies nothing too, but it is an error, not a clean negative.
    cleanNegatives: negatives.filter((s) => s.applied === 0 && s.failures === 0).length,
  } as GoverningMetrics;
  for (const m of RATIO_METRICS) {
    const [num, den] = RATIOS[m];
    out[m] = ratio(sum(scores, num), sum(scores, den));
  }
  return out;
}

/** A metric averaged over runs, with its interval. */
export interface MetricSummary {
  /** Mean over the runs where the metric is defined; null when it never is. */
  mean: number | null;
  /** 95% bootstrap interval over items (counts pooled across runs); null when undefined. */
  ci: [number, number] | null;
  perRun: Array<number | null>;
}

export interface MetricsSummary {
  runs: number;
  metrics: Record<RatioMetric, MetricSummary>;
  /** Hard errors summed over every run. */
  hardErrors: number;
  hardErrorsPerRun: number[];
  cleanNegatives: number[];
  negatives: number;
}

export interface BootstrapOptions {
  iterations?: number;
  seed?: number;
  alpha?: number;
}

/**
 * A seeded bootstrap interval for a ratio of sums: resample items with
 * replacement, recompute Σnum / Σden. Null when the denominator is 0.
 */
export function bootstrapRatioCi(
  nums: readonly number[],
  dens: readonly number[],
  opts: BootstrapOptions = {},
): [number, number] | null {
  if (nums.length !== dens.length) throw new Error("a ratio interval needs paired counts");
  const n = nums.length;
  if (n === 0 || dens.reduce((a, b) => a + b, 0) === 0) return null;
  const iterations = opts.iterations ?? 5_000;
  const alpha = opts.alpha ?? 0.05;
  const rand = seededRandom(opts.seed ?? 1867);
  const draws: number[] = [];
  for (let it = 0; it < iterations; it++) {
    let num = 0;
    let den = 0;
    for (let j = 0; j < n; j++) {
      const k = Math.floor(rand() * n);
      num += nums[k]!;
      den += dens[k]!;
    }
    // A resample with no denominator says nothing about the ratio: skip it.
    if (den > 0) draws.push(num / den);
  }
  draws.sort((a, b) => a - b);
  const at = (q: number) => {
    const pos = (draws.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return draws[lo]! + (draws[hi]! - draws[lo]!) * (pos - lo);
  };
  return [at(alpha / 2), at(1 - alpha / 2)];
}

/**
 * Summarise an arm over its runs. `runs[r]` holds the item scores of run r,
 * in the same item order. The mean is over runs; the interval pools each
 * item's counts across runs and resamples items.
 */
export function summarizeRuns(
  runs: ReadonlyArray<readonly ItemCounts[]>,
  opts: BootstrapOptions = {},
): MetricsSummary {
  const perRun = runs.map((scores) => aggregate(scores));
  const items = runs[0]?.length ?? 0;
  const pooled = (key: keyof ItemCounts) =>
    Array.from({ length: items }, (_, i) => runs.reduce((n, scores) => n + scores[i]![key], 0));
  const metrics = {} as Record<RatioMetric, MetricSummary>;
  for (const m of RATIO_METRICS) {
    const values = perRun.map((r) => r[m]);
    const defined = values.filter((v): v is number => v !== null);
    const [num, den] = RATIOS[m];
    metrics[m] = {
      mean: defined.length === 0 ? null : defined.reduce((a, b) => a + b, 0) / defined.length,
      ci: bootstrapRatioCi(pooled(num), pooled(den), opts),
      perRun: values,
    };
  }
  return {
    runs: runs.length,
    metrics,
    hardErrors: perRun.reduce((n, r) => n + r.hardErrors, 0),
    hardErrorsPerRun: perRun.map((r) => r.hardErrors),
    cleanNegatives: perRun.map((r) => r.cleanNegatives),
    negatives: perRun[0]?.negatives ?? 0,
  };
}

/** The bars a summary is checked against (the manifest's thresholds). */
export interface ThresholdBars {
  overallRecall: number;
  nonResemblingRecall: number;
  precision: number;
  citationAccuracy: number;
  maxNoEvidenceCompliantErrors: number;
}

export interface ThresholdCheck {
  bar: keyof ThresholdBars;
  required: string;
  measured: string;
  /** Null when the arm cannot fail the bar by construction (`note` says why). */
  pass: boolean | null;
  note?: string;
}

/** The metric each bar reads, where an arm may fix that metric by construction. */
const BAR_METRIC: Partial<Record<keyof ThresholdBars, keyof ByConstruction>> = {
  citationAccuracy: "citationAccuracy",
  maxNoEvidenceCompliantErrors: "hardErrors",
};

/**
 * Each bar against the run-mean (hard errors: the most any one run made). A
 * null metric fails; a bar on a metric the arm fixes by construction is
 * neither passed nor failed (`pass: null`).
 */
export function checkThresholds(
  s: MetricsSummary,
  bars: ThresholdBars,
  byConstruction: ByConstruction = {},
): ThresholdCheck[] {
  const fmt = (v: number | null) => (v === null ? "n/a" : v.toFixed(2));
  const atLeast = (bar: keyof ThresholdBars, metric: RatioMetric): ThresholdCheck => {
    const v = s.metrics[metric].mean;
    return {
      bar,
      required: `≥ ${bars[bar].toFixed(2)}`,
      measured: fmt(v),
      pass: v !== null && v >= bars[bar],
    };
  };
  const worstRun = Math.max(0, ...s.hardErrorsPerRun);
  const checks: ThresholdCheck[] = [
    atLeast("overallRecall", "recall"),
    atLeast("nonResemblingRecall", "nonResemblingRecall"),
    atLeast("precision", "precision"),
    atLeast("citationAccuracy", "citationAccuracy"),
    {
      bar: "maxNoEvidenceCompliantErrors",
      required: `≤ ${bars.maxNoEvidenceCompliantErrors} per run`,
      measured: `${worstRun} (worst run)`,
      pass: worstRun <= bars.maxNoEvidenceCompliantErrors,
    },
  ];
  return checks.map((c) => {
    const metric = BAR_METRIC[c.bar];
    const reason = metric ? byConstruction[metric] : undefined;
    return reason === undefined ? c : { ...c, pass: null, note: reason };
  });
}
