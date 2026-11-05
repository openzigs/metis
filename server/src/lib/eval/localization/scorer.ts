/**
 * #1753 — pure file-localization metrics for one requirement, and their
 * aggregates. Every arm of epic #1751 is scored by exactly these functions.
 *
 *   Recall@k         = |top-k ranked files ∩ expected| / |expected|
 *   edit precision   = |edit candidates ∩ expected| / |edit candidates|
 *   reciprocal rank  = 1 / rank of the first expected file in the ranking (0 if none)
 *   graph resolution = |LLM-named files ∩ code graph| / |LLM-named files|
 *   repo confinement = every edit candidate is in the answer's ONE repository
 *                      (#1784; only for an item whose answer is in one repository)
 *
 * Empty-set conventions match the impact-recall scorer
 * (`impact-recall/scorer.ts`, the #738 reqmap convention):
 *   - expected empty ⇒ recall = 1 and reciprocal rank = 1 (nothing to find);
 *   - found empty    ⇒ precision = 1 and graph resolution = 1 (nothing surfaced,
 *     nothing wrong surfaced).
 * Because an empty edit list scores a VACUOUS precision of 1, every aggregate
 * also counts the requirements that named no edit candidate, so a silent arm is
 * never read as a precise one.
 */
import type { GapVerdict } from "./corpus.js";

/** What one arm produced for one requirement on one run. */
export interface ArmObservation {
  /** Every file the arm surfaced, best first, `<repo>:<path>`, deduplicated. */
  rankedFiles: string[];
  /** The files the arm says the change edits. */
  editCandidateFiles: string[];
  /**
   * Files a language model NAMED (as text), before any check against the graph.
   * Absent for an arm with no model in the loop: graph resolution is then n/a.
   */
  llmNamedFiles?: string[];
  /** The portfolio verdict, for an arm that gives one. */
  verdict?: GapVerdict;
  /** Dollars this requirement cost, from the usage ledger's pricing; null = unpriced. */
  costUsd: number | null;
  /** Wall-clock seconds this requirement took. */
  seconds: number;
  /** #1755 — agent-loop turns this requirement took; absent for an arm with no agent loop. */
  agentTurns?: number;
}

/** The scores of one requirement on one run. */
export interface ItemRunScore {
  recallAt5: number;
  recallAt10: number;
  editPrecision: number;
  reciprocalRank: number;
  /** null when the arm named no file through a model. */
  graphResolution: number | null;
  /** null when the arm gives no verdict, or the item expects none. */
  verdictCorrect: boolean | null;
  /**
   * #1784 — true when the arm named at least one edit candidate and every one
   * is in the answer's repository. null when the answer spans several
   * repositories (or names none): there is no single repository to stay in.
   */
  editRepoConfined: boolean | null;
  editCandidateCount: number;
  costUsd: number | null;
  seconds: number;
  /** #1755 — agent-loop turns; absent for an arm with no agent loop. */
  agentTurns?: number;
}

/** Recall of the top `k` ranked files against `expected`. */
export function recallAtK(
  ranked: readonly string[],
  expected: readonly string[],
  k: number,
): number {
  const want = new Set(expected);
  if (want.size === 0) return 1;
  const top = new Set(ranked.slice(0, k));
  let hit = 0;
  for (const f of want) if (top.has(f)) hit++;
  return hit / want.size;
}

/** Share of `found` that is in `expected`; 1 when nothing was found. */
export function precisionOf(found: readonly string[], expected: readonly string[]): number {
  const got = new Set(found);
  if (got.size === 0) return 1;
  const want = new Set(expected);
  let hit = 0;
  for (const f of got) if (want.has(f)) hit++;
  return hit / got.size;
}

/** 1 / the 1-based rank of the first expected file; 0 when none is ranked. */
export function reciprocalRank(ranked: readonly string[], expected: readonly string[]): number {
  const want = new Set(expected);
  if (want.size === 0) return 1;
  const i = ranked.findIndex((f) => want.has(f));
  return i < 0 ? 0 : 1 / (i + 1);
}

/** Share of model-named files the code graph holds; null when the arm named none by model. */
export function graphResolutionRate(
  named: readonly string[] | undefined,
  graphFiles: ReadonlySet<string>,
): number | null {
  if (named === undefined) return null;
  const set = new Set(named);
  if (set.size === 0) return 1;
  let resolved = 0;
  for (const f of set) if (graphFiles.has(f)) resolved++;
  return resolved / set.size;
}

/**
 * #1784 — whether every edit candidate (`<repo>:<path>`) is in `repo`; false
 * when there is none, so a silent arm is never read as a confined one.
 */
export function editConfinedToRepo(editFiles: readonly string[], repo: string): boolean {
  return editFiles.length > 0 && editFiles.every((f) => f.startsWith(`${repo}:`));
}

/** Score one observation of one requirement. */
export function scoreObservation(
  expected: readonly string[],
  obs: ArmObservation,
  graphFiles: ReadonlySet<string>,
  expectedVerdict?: GapVerdict,
  /** The repositories the answer is in; one repository makes confinement scorable. */
  expectedRepos?: readonly string[],
): ItemRunScore {
  return {
    recallAt5: recallAtK(obs.rankedFiles, expected, 5),
    recallAt10: recallAtK(obs.rankedFiles, expected, 10),
    editPrecision: precisionOf(obs.editCandidateFiles, expected),
    reciprocalRank: reciprocalRank(obs.rankedFiles, expected),
    graphResolution: graphResolutionRate(obs.llmNamedFiles, graphFiles),
    verdictCorrect:
      obs.verdict === undefined || expectedVerdict === undefined
        ? null
        : obs.verdict === expectedVerdict,
    editRepoConfined:
      expectedRepos?.length === 1
        ? editConfinedToRepo(obs.editCandidateFiles, expectedRepos[0]!)
        : null,
    editCandidateCount: new Set(obs.editCandidateFiles).size,
    costUsd: obs.costUsd,
    seconds: obs.seconds,
    ...(obs.agentTurns === undefined ? {} : { agentTurns: obs.agentTurns }),
  };
}

/** The continuous metrics a paired comparison reads, by name. */
export const PAIRED_METRICS = [
  "recallAt5",
  "recallAt10",
  "editPrecision",
  "reciprocalRank",
] as const;
export type PairedMetric = (typeof PAIRED_METRICS)[number];

/** One requirement's scores averaged over its runs. */
export interface ItemScore {
  id: string;
  runs: number;
  recallAt5: number;
  recallAt10: number;
  editPrecision: number;
  reciprocalRank: number;
  graphResolution: number | null;
  /** Share of runs with ≥1 expected file in the top 5 / top 10 (McNemar reads it as hit ≥ 0.5). */
  hitAt5: number;
  hitAt10: number;
  verdictAccuracy: number | null;
  /** #1784 — share of runs whose edit candidates stayed in the answer's one repository; null when n/a. */
  editRepoConfined: number | null;
  editCandidateCount: number;
  /** Mean dollars per run; null when any run was unpriced. */
  costUsd: number | null;
  seconds: number;
  /** #1755 — mean agent-loop turns per run; absent for an arm with no agent loop. */
  agentTurns?: number;
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function meanOrNull(values: ReadonlyArray<number | null>): number | null {
  const present = values.filter((v): v is number => v !== null);
  return present.length === 0 ? null : mean(present);
}

/** Average one requirement's runs. Throws on no runs: there is nothing to average. */
export function averageRuns(id: string, runs: readonly ItemRunScore[]): ItemScore {
  if (runs.length === 0) throw new Error(`no runs to average for ${id}`);
  const pick = (f: (r: ItemRunScore) => number) => mean(runs.map(f));
  const turns = meanOrNull(runs.map((r) => r.agentTurns ?? null));
  const verdicts = runs.map((r) => (r.verdictCorrect === null ? null : r.verdictCorrect ? 1 : 0));
  const confined = runs.map((r) =>
    r.editRepoConfined === null ? null : r.editRepoConfined ? 1 : 0,
  );
  return {
    id,
    runs: runs.length,
    recallAt5: pick((r) => r.recallAt5),
    recallAt10: pick((r) => r.recallAt10),
    editPrecision: pick((r) => r.editPrecision),
    reciprocalRank: pick((r) => r.reciprocalRank),
    graphResolution: meanOrNull(runs.map((r) => r.graphResolution)),
    hitAt5: pick((r) => (r.recallAt5 > 0 ? 1 : 0)),
    hitAt10: pick((r) => (r.recallAt10 > 0 ? 1 : 0)),
    verdictAccuracy: meanOrNull(verdicts),
    editRepoConfined: meanOrNull(confined),
    editCandidateCount: pick((r) => r.editCandidateCount),
    costUsd: runs.some((r) => r.costUsd === null) ? null : pick((r) => r.costUsd ?? 0),
    seconds: pick((r) => r.seconds),
    ...(turns === null ? {} : { agentTurns: turns }),
  };
}

/** One arm's aggregate over a corpus (each requirement weighted equally). */
export interface ArmAggregate {
  items: number;
  recallAt5: number;
  recallAt10: number;
  editPrecision: number;
  mrr: number;
  /** Mean over the items whose arm named files by model; null when none did. */
  graphResolution: number | null;
  verdictAccuracy: number | null;
  /**
   * #1784 — of the requirements whose answer is in ONE repository, how many
   * kept their edit candidates in it (on at least half their runs); null when
   * no requirement has a single-repository answer.
   */
  repoConfinement: { confined: number; of: number } | null;
  /** Requirements with no edit candidate on any run: their precision of 1 is vacuous. */
  itemsWithNoEditCandidate: number;
  meanEditCandidates: number;
  /** Mean dollars and seconds per requirement; cost null when any requirement was unpriced. */
  costUsdPerRequirement: number | null;
  secondsPerRequirement: number;
  totalCostUsd: number | null;
  /** #1755 — mean agent-loop turns per requirement; null when no item ran an agent loop. */
  agentTurnsPerRequirement: number | null;
}

/** Aggregate per-requirement scores. */
export function aggregateItems(items: readonly ItemScore[]): ArmAggregate {
  const pick = (f: (s: ItemScore) => number) => mean(items.map(f));
  const unpriced = items.some((s) => s.costUsd === null);
  const totalCost = items.reduce((sum, s) => sum + (s.costUsd ?? 0) * s.runs, 0);
  return {
    items: items.length,
    recallAt5: pick((s) => s.recallAt5),
    recallAt10: pick((s) => s.recallAt10),
    editPrecision: pick((s) => s.editPrecision),
    mrr: pick((s) => s.reciprocalRank),
    graphResolution: meanOrNull(items.map((s) => s.graphResolution)),
    verdictAccuracy: meanOrNull(items.map((s) => s.verdictAccuracy)),
    repoConfinement: repoConfinementOf(items),
    itemsWithNoEditCandidate: items.filter((s) => s.editCandidateCount === 0).length,
    meanEditCandidates: pick((s) => s.editCandidateCount),
    costUsdPerRequirement: unpriced ? null : pick((s) => s.costUsd ?? 0),
    secondsPerRequirement: pick((s) => s.seconds),
    totalCostUsd: unpriced ? null : totalCost,
    agentTurnsPerRequirement: meanOrNull(items.map((s) => s.agentTurns ?? null)),
  };
}

function repoConfinementOf(items: readonly ItemScore[]): ArmAggregate["repoConfinement"] {
  const scorable = items.filter((s) => s.editRepoConfined !== null);
  if (scorable.length === 0) return null;
  return {
    confined: scorable.filter((s) => (s.editRepoConfined ?? 0) >= 0.5).length,
    of: scorable.length,
  };
}
