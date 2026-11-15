/**
 * #1766 — score portfolio gap verdicts against the fixture-repo set's ground
 * truth (`eval-data/corpus/localization-02-fixture-portfolio`, #1753).
 *
 * The gap engine (`portfolio/gap-engine.ts`) gates `implemented` on a
 * citation; whether the verdict is RIGHT was never measured. Per arm, over every
 * run of every item, this module computes:
 *
 *   - verdict accuracy over the items, and stratified by the answer's repository;
 *   - the answer repository's own verdict, on items with a one-repository answer;
 *   - a confusion matrix (expected × predicted, `could-not-verify` a column);
 *   - the uncited `implemented` count, which must be 0 ({@link uncitedViolations});
 *   - citation validity: the cited file exists in that repository at the pinned
 *     commit, and the cited lines fall inside it;
 *   - expected-repository recall, on items whose answer is `implemented` or
 *     `partial`: the share of answer repositories found implementing a criterion;
 *   - dollars and seconds per requirement.
 *
 * Arms are compared on the same items: a paired bootstrap of per-item accuracy
 * (each item's mean over its runs) and the exact McNemar test on per-item
 * majority correctness. Pure: no I/O, no engine import.
 */
import type { FindingVerdict, PortfolioCoverage, RequirementVerdict } from "@metis/shared";
import type { GapVerdict, LocalizationItem } from "../localization/corpus.js";
import {
  bootstrapMeanCi,
  mcnemarExact,
  pairedBootstrap,
  readDifference,
  type ComparisonVerdict,
  type PairedDifference,
} from "../localization/stats.js";

/** What a scored verdict can be: the expected three, or the engine declining to say. */
export const PREDICTED_VERDICTS = ["implemented", "partial", "gap", "could-not-verify"] as const;
export type PredictedVerdict = (typeof PREDICTED_VERDICTS)[number];

/** The ground truth one item is scored against. */
export type GapTruth = Pick<LocalizationItem, "id" | "expectedRepos"> & {
  expectedVerdict: GapVerdict;
};

/** One cited span, as the engine stamped it. */
export interface CitedSpan {
  filePath: string;
  startLine: number;
  endLine: number;
}

/** One repository's part of a verdict, keyed by the corpus's repository name. */
export interface GapRepoOutcome {
  repo: string;
  verdict: RequirementVerdict;
  criteria: FindingVerdict[];
  citations: CitedSpan[];
  /** Why the repository could not be verified, or null. */
  reason: string | null;
}

/** One run of one item under one arm: what the engine answered, and what it cost. */
export interface GapItemOutcome {
  itemId: string;
  arm: string;
  run: number;
  /** `<provider>/<model>` the run called. */
  model: string;
  verdict: RequirementVerdict;
  /** The product's coverage (the corpus is checked as one product). */
  productCoverage: PortfolioCoverage | null;
  /** How many criteria the engine judged. */
  criteriaCount: number;
  repos: GapRepoOutcome[];
  /** Ledger dollars of the run's model calls. */
  costUsd: number;
  seconds: number;
}

/** The fields of a gap result this module reads (`PortfolioGapResult`, structurally). */
export interface GapResultLike {
  verdict: RequirementVerdict;
  criteria: readonly string[];
  products: readonly {
    coverage: PortfolioCoverage;
    repos: readonly {
      repoConnectionId: string;
      label: string;
      verdict: RequirementVerdict;
      criteria: readonly FindingVerdict[];
      citations: readonly { filePath: string; startLine: number; endLine: number }[];
      reason: string | null;
    }[];
  }[];
}

/**
 * The outcome of one engine run, repositories renamed to the corpus's names by
 * `repoNameOf` (connector id → name). A connector it does not know keeps its
 * label, so a stray repository is reported, never dropped.
 */
export function outcomeFromResult(
  result: GapResultLike,
  meta: Pick<GapItemOutcome, "itemId" | "arm" | "run" | "model" | "costUsd" | "seconds">,
  repoNameOf: ReadonlyMap<string, string>,
): GapItemOutcome {
  return {
    ...meta,
    verdict: result.verdict,
    productCoverage: result.products[0]?.coverage ?? null,
    criteriaCount: result.criteria.length,
    repos: result.products.flatMap((p) =>
      p.repos.map((r) => ({
        repo: repoNameOf.get(r.repoConnectionId) ?? r.label,
        verdict: r.verdict,
        criteria: [...r.criteria],
        citations: r.citations.map(({ filePath, startLine, endLine }) => ({
          filePath,
          startLine,
          endLine,
        })),
        reason: r.reason,
      })),
    ),
  };
}

/** The engine's verdict in the ground truth's words. */
export function predictedOf(verdict: RequirementVerdict): PredictedVerdict {
  return verdict === "gap-confirmed" ? "gap" : verdict;
}

/** A product coverage in the ground truth's words. */
export function predictedOfCoverage(coverage: PortfolioCoverage | null): PredictedVerdict {
  switch (coverage) {
    case "covers":
      return "implemented";
    case "partial":
      return "partial";
    case "not-covered":
      return "gap";
    default:
      return "could-not-verify";
  }
}

/**
 * Each repository's files at the pinned commit and their line counts:
 * `files.get(repo)?.get(path)` is the line count of `path`.
 */
export type RepoFileIndex = ReadonlyMap<string, ReadonlyMap<string, number>>;

/** Whether a citation names a file of its repository and lines inside that file. */
export function citationValid(repo: string, span: CitedSpan, files: RepoFileIndex): boolean {
  const lines = files.get(repo)?.get(span.filePath);
  if (lines === undefined) return false;
  return span.startLine >= 1 && span.startLine <= span.endLine && span.endLine <= lines;
}

/**
 * Uncited `implemented` claims in one outcome: each repository holding an
 * `implemented` criterion with no citation, plus one when the portfolio verdict
 * claims coverage (`implemented` or `partial`) that no citation backs.
 */
export function uncitedImplemented(outcome: GapItemOutcome): number {
  const repos = outcome.repos.filter(
    (r) => r.criteria.includes("implemented") && r.citations.length === 0,
  ).length;
  const claimsCoverage = outcome.verdict === "implemented" || outcome.verdict === "partial";
  const anyCitation = outcome.repos.some((r) => r.citations.length > 0);
  return repos + (claimsCoverage && !anyCitation ? 1 : 0);
}

/** One outcome scored. */
export interface ScoredOutcome {
  itemId: string;
  run: number;
  expected: GapVerdict;
  predicted: PredictedVerdict;
  correct: boolean;
  productPredicted: PredictedVerdict;
  /** The answer repository's own verdict; null unless the answer is one repository. */
  answerRepoPredicted: PredictedVerdict | null;
  uncited: number;
  citations: number;
  validCitations: number;
  /** Answer repositories found implementing a criterion; null for a `gap` answer. */
  expectedRepoRecall: number | null;
  costUsd: number;
  seconds: number;
}

export function scoreOutcome(
  truth: GapTruth,
  outcome: GapItemOutcome,
  files: RepoFileIndex,
): ScoredOutcome {
  if (truth.id !== outcome.itemId) {
    throw new Error(`scoring ${outcome.itemId} against the ground truth of ${truth.id}`);
  }
  const predicted = predictedOf(outcome.verdict);
  const byRepo = new Map(outcome.repos.map((r) => [r.repo, r]));
  const only = truth.expectedRepos.length === 1 ? byRepo.get(truth.expectedRepos[0]) : undefined;
  let citations = 0;
  let validCitations = 0;
  for (const r of outcome.repos) {
    for (const c of r.citations) {
      citations++;
      if (citationValid(r.repo, c, files)) validCitations++;
    }
  }
  const expected = [...new Set(truth.expectedRepos)];
  const found = expected.filter((name) => byRepo.get(name)?.criteria.includes("implemented"));
  return {
    itemId: outcome.itemId,
    run: outcome.run,
    expected: truth.expectedVerdict,
    predicted,
    correct: predicted === truth.expectedVerdict,
    productPredicted: predictedOfCoverage(outcome.productCoverage),
    answerRepoPredicted:
      truth.expectedRepos.length === 1
        ? only
          ? predictedOf(only.verdict)
          : "could-not-verify"
        : null,
    uncited: uncitedImplemented(outcome),
    citations,
    validCitations,
    expectedRepoRecall:
      truth.expectedVerdict === "gap" || expected.length === 0
        ? null
        : found.length / expected.length,
    costUsd: outcome.costUsd,
    seconds: outcome.seconds,
  };
}

/** Expected (rows) × predicted (columns) counts over every scored outcome. */
export type ConfusionMatrix = Record<GapVerdict, Record<PredictedVerdict, number>>;

export function confusionMatrix(scored: readonly ScoredOutcome[]): ConfusionMatrix {
  const row = (): Record<PredictedVerdict, number> => ({
    implemented: 0,
    partial: 0,
    gap: 0,
    "could-not-verify": 0,
  });
  const m: ConfusionMatrix = { implemented: row(), partial: row(), gap: row() };
  for (const s of scored) m[s.expected][s.predicted]++;
  return m;
}

/** An accuracy and its 95% bootstrap interval over items. */
export interface Rate {
  value: number;
  ci: [number, number];
  /** Items it is over. */
  n: number;
}

const mean = (xs: readonly number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

/** Per item, the mean of `pick` over its runs; items with no value are left out. */
function perItemMeans(
  scored: readonly ScoredOutcome[],
  pick: (s: ScoredOutcome) => number | null,
): Map<string, number> {
  const by = new Map<string, number[]>();
  for (const s of scored) {
    const v = pick(s);
    if (v === null) continue;
    const list = by.get(s.itemId) ?? [];
    list.push(v);
    by.set(s.itemId, list);
  }
  return new Map([...by].map(([id, vs]) => [id, mean(vs)]));
}

function rateOf(
  scored: readonly ScoredOutcome[],
  pick: (s: ScoredOutcome) => number | null,
  seed: number,
): Rate | null {
  const values = [...perItemMeans(scored, pick).values()];
  if (values.length === 0) return null;
  return { value: mean(values), ci: bootstrapMeanCi(values, { seed }), n: values.length };
}

/** The stratum of an item: its answer repository, or `multi-repo`. */
export function stratumOf(truth: Pick<GapTruth, "expectedRepos">): string {
  const repos = [...new Set(truth.expectedRepos)];
  return repos.length === 1 ? repos[0] : "multi-repo";
}

/** One arm's scores over all its outcomes. */
export interface ArmSummary {
  arm: string;
  model: string;
  /** Outcomes scored (items × runs). */
  outcomes: number;
  /** Runs with an outcome for every item. */
  completeRuns: number;
  accuracy: Rate | null;
  productAccuracy: Rate | null;
  /** The answer repository's own verdict, one-repository items only. */
  answerRepoAccuracy: Rate | null;
  /** Accuracy by answer repository (`multi-repo` for the rest). */
  accuracyByStratum: Record<string, Rate>;
  /** Accuracy by expected verdict: the recall of each class. */
  accuracyByExpected: Partial<Record<GapVerdict, Rate>>;
  confusion: ConfusionMatrix;
  uncitedImplemented: number;
  citations: number;
  validCitations: number;
  expectedRepoRecall: Rate | null;
  usdPerRequirement: number;
  secondsPerRequirement: number;
  spentUsd: number;
}

/** The truth of every item, by id; throws on an outcome naming an unknown item. */
function truthFor(truths: readonly GapTruth[]): (id: string) => GapTruth {
  const by = new Map(truths.map((t) => [t.id, t]));
  return (id) => {
    const t = by.get(id);
    if (!t) throw new Error(`no ground truth for item ${id}`);
    return t;
  };
}

export function summarizeArm(
  arm: string,
  model: string,
  truths: readonly GapTruth[],
  outcomes: readonly GapItemOutcome[],
  files: RepoFileIndex,
): ArmSummary {
  const truth = truthFor(truths);
  const scored = scoreArm(arm, model, truths, outcomes, files);
  const runs = new Map<number, Set<string>>();
  for (const s of scored) runs.set(s.run, (runs.get(s.run) ?? new Set()).add(s.itemId));
  const completeRuns = [...runs.values()].filter((ids) =>
    truths.every((t) => ids.has(t.id)),
  ).length;
  const accuracyByStratum: Record<string, Rate> = {};
  for (const stratum of [...new Set(truths.map(stratumOf))].sort()) {
    const r = rateOf(
      scored.filter((s) => stratumOf(truth(s.itemId)) === stratum),
      (s) => (s.correct ? 1 : 0),
      1766,
    );
    if (r) accuracyByStratum[stratum] = r;
  }
  const accuracyByExpected: Partial<Record<GapVerdict, Rate>> = {};
  for (const v of ["implemented", "partial", "gap"] as const) {
    const r = rateOf(
      scored.filter((s) => s.expected === v),
      (s) => (s.correct ? 1 : 0),
      1766,
    );
    if (r) accuracyByExpected[v] = r;
  }
  const spentUsd = scored.reduce((a, s) => a + s.costUsd, 0);
  return {
    arm,
    model,
    outcomes: scored.length,
    completeRuns,
    accuracy: rateOf(scored, (s) => (s.correct ? 1 : 0), 1766),
    productAccuracy: rateOf(scored, (s) => (s.productPredicted === s.expected ? 1 : 0), 1766),
    answerRepoAccuracy: rateOf(
      scored,
      (s) => (s.answerRepoPredicted === null ? null : s.answerRepoPredicted === s.expected ? 1 : 0),
      1766,
    ),
    accuracyByStratum,
    accuracyByExpected,
    confusion: confusionMatrix(scored),
    uncitedImplemented: scored.reduce((a, s) => a + s.uncited, 0),
    citations: scored.reduce((a, s) => a + s.citations, 0),
    validCitations: scored.reduce((a, s) => a + s.validCitations, 0),
    expectedRepoRecall: rateOf(scored, (s) => s.expectedRepoRecall, 1766),
    usdPerRequirement: scored.length === 0 ? 0 : spentUsd / scored.length,
    secondsPerRequirement: mean(scored.map((s) => s.seconds)),
    spentUsd,
  };
}

/** The arms with an uncited `implemented` claim: any is a failed run. */
export function uncitedViolations(summaries: readonly ArmSummary[]): string[] {
  return summaries
    .filter((s) => s.uncitedImplemented > 0)
    .map((s) => `${s.arm} (${s.model}): ${s.uncitedImplemented} uncited implemented`);
}

/** One arm against the baseline, on the items both scored. */
export interface ArmComparison {
  arm: string;
  baseline: string;
  /** Paired bootstrap of per-item accuracy (each item's mean over its runs). */
  accuracy: PairedDifference;
  /** Exact McNemar on per-item majority correctness (correct in more than half its runs). */
  mcnemar: { armOnly: number; baselineOnly: number; p: number };
  reading: ComparisonVerdict;
}

export function compareArms(
  baseline: { arm: string; scored: readonly ScoredOutcome[] },
  arm: { arm: string; scored: readonly ScoredOutcome[] },
): ArmComparison {
  const correct = (s: ScoredOutcome) => (s.correct ? 1 : 0);
  const base = perItemMeans(baseline.scored, correct);
  const other = perItemMeans(arm.scored, correct);
  const ids = [...base.keys()].filter((id) => other.has(id)).sort();
  const b = ids.map((id) => base.get(id)!);
  const a = ids.map((id) => other.get(id)!);
  const accuracy = pairedBootstrap(b, a, { seed: 1766 });
  let armOnly = 0;
  let baselineOnly = 0;
  for (let i = 0; i < ids.length; i++) {
    const armHit = a[i] > 0.5;
    const baseHit = b[i] > 0.5;
    if (armHit && !baseHit) armOnly++;
    if (baseHit && !armHit) baselineOnly++;
  }
  return {
    arm: arm.arm,
    baseline: baseline.arm,
    accuracy,
    mcnemar: { armOnly, baselineOnly, p: mcnemarExact(armOnly, baselineOnly) },
    reading: readDifference(accuracy),
  };
}

/** Every outcome of `arm` on `model`, scored. */
export function scoreArm(
  arm: string,
  model: string,
  truths: readonly GapTruth[],
  outcomes: readonly GapItemOutcome[],
  files: RepoFileIndex,
): ScoredOutcome[] {
  const truth = truthFor(truths);
  return outcomes
    .filter((o) => o.arm === arm && o.model === model)
    .map((o) => scoreOutcome(truth(o.itemId), o, files));
}

/** The ground truth of a corpus's items; every item must carry a verdict. */
export function gapTruths(items: readonly LocalizationItem[]): GapTruth[] {
  return items.map((item) => {
    if (item.expectedVerdict === undefined) {
      throw new Error(`item ${item.id} has no expected verdict`);
    }
    return {
      id: item.id,
      expectedRepos: item.expectedRepos,
      expectedVerdict: item.expectedVerdict,
    };
  });
}
