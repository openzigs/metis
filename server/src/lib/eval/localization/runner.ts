/**
 * #1753 — run arms over a localization corpus, score them, and compare each
 * with A0 on the same items.
 *
 * Runs are RUN-MAJOR (every arm finishes run 1 before any starts run 2). A cap
 * that trips inside a later arm still leaves the earlier arms one run ahead, so
 * every arm is SCORED on the runs all of them completed and the rest are
 * dropped and counted; when even run 1 is incomplete, the partial run is scored
 * and the report says that the arms cover different items (#1770).
 *
 * The cap is checked before each requirement against what has been spent plus
 * the most one requirement of THAT arm has cost so far, and before each
 * table-precision guard against the most a guard has cost — unless the guard
 * says its next reading is free (a memoised reading, or an arm with no guard
 * run), which no cap can refuse (#1779). The look-ahead lives
 * in an {@link EvalBudget} the caller shares across corpora, so the first item
 * of a second corpus is not run blind (#1770). Nothing starts once the spend has
 * reached the budget, so `--budget 0` runs nothing. An unpriced call stops the
 * run too: unknown spend cannot be held under a cap.
 *
 * #1800 — a run can be done in SLICES and RESUMED: scores an earlier call
 * recorded (a {@link RunCheckpoint}) are loaded and never re-run, `runItem`
 * says which of the rest this call may run, and every new score is handed to
 * the checkpoint as soon as it exists. The report is always built from every
 * score held, recorded or new, so three slices and a merge give the report one
 * full run gives; the requirements still missing are listed (`missing`).
 *
 * Pure orchestration over injected arms, meter and clock: no environment
 * reads, no network of its own.
 */
import { ANALYSIS_PASS_GROUP } from "./agent-env.js";
import type { LocalizationArm } from "./arms.js";
import type { LocalizationCorpus, LocalizationItem } from "./corpus.js";
import type { CostMeter } from "./cost.js";
import {
  PAIRED_METRICS,
  aggregateItems,
  averageRuns,
  scoreObservation,
  type ArmAggregate,
  type ItemRunScore,
  type ItemScore,
  type PairedMetric,
} from "./scorer.js";
import {
  bootstrapMeanCi,
  mcnemarExact,
  minimumDetectableGapStatement,
  readDifference,
  stratifiedPairedBootstrap,
  type ComparisonVerdict,
  type PairedDifference,
  type PairedStratum,
} from "./stats.js";

/** Default runs per arm: the arms with a model in the loop are not deterministic. */
export const DEFAULT_RUNS = 3;
/** Default dollar cap for one invocation. */
export const DEFAULT_BUDGET_USD = 35;
/** The table-precision guard rail: no arm may drop it more than this below A0. */
export const TABLE_PRECISION_TOLERANCE = 0.03;

/** Recall@10 carries no signal on a code graph this small: ranking every file finds them all. */
export const RECALL_AT_10_TRIVIAL_GRAPH_FILES = 10;

/**
 * The dollar cap and its look-ahead, shared by every {@link runLocalizationEval}
 * call of one invocation (the CLI runs one per corpus over one meter). It holds
 * the most one requirement has cost per ARM, so a free arm (A0) gives no false
 * all-clear for a model-backed one, and the most one table guard has cost.
 */
export class EvalBudget {
  private readonly maxItemCostByArm = new Map<string, number>();
  private maxGuardCost = 0;

  constructor(readonly budgetUsd: number) {
    if (!Number.isFinite(budgetUsd) || budgetUsd < 0) {
      throw new Error(`the budget must be a non-negative number of dollars, not ${budgetUsd}`);
    }
  }

  /** Why the next requirement of `armId` may not start, or null when it may. */
  beforeItem(meter: CostMeter, armId: string): string | null {
    return this.blocked(meter, this.maxItemCostByArm.get(armId) ?? 0);
  }

  /** Why the next table-precision guard may not start, or null when it may. */
  beforeGuard(meter: CostMeter): string | null {
    return this.blocked(meter, this.maxGuardCost);
  }

  observeItem(armId: string, costUsd: number): void {
    this.maxItemCostByArm.set(armId, Math.max(this.maxItemCostByArm.get(armId) ?? 0, costUsd));
  }

  observeGuard(costUsd: number): void {
    this.maxGuardCost = Math.max(this.maxGuardCost, costUsd);
  }

  private blocked(meter: CostMeter, nextUsd: number): string | null {
    if (meter.unpricedCalls() > 0) return "an unpriced model call";
    const spent = meter.spentUsd();
    if (spent >= this.budgetUsd) {
      return `budget: $${spent.toFixed(4)} spent of $${this.budgetUsd}`;
    }
    if (spent + nextUsd > this.budgetUsd) {
      return `budget: $${spent.toFixed(4)} spent + up to $${nextUsd.toFixed(4)} next > $${this.budgetUsd}`;
    }
    return null;
  }
}

/** One measured table precision, and what produced it. */
export interface TableGuardMeasurement {
  tablePrecision: number;
  runs: number;
  configuration: string;
  /**
   * #1786 — how the guard's requirements were seeded into code: the mapper
   * (`mapRequirementToCode`), or the split hybrid seeding (with or without the
   * edit-candidate check). Two readings compare only on the same seeding.
   */
  seeding: string;
  /**
   * #1823 — the arm a `baseline` reading belongs to, when it is not A0: A7 is
   * gated against A7O, the same analyses with `IMPACT_AGENT_SEEDS` off (owner
   * decision 2026-11-05), not against A0.
   */
  arm?: string;
}

/**
 * The table-precision guard rail reading for one arm. `baseline` (#1786) is
 * A0 measured on THIS reading's seeding, when that is not A0's own: the arm is
 * gated against it, so a seeding change is never read as the arm's effect.
 */
export type TableGuardReading =
  | ({ measured: true; baseline?: TableGuardMeasurement } & TableGuardMeasurement)
  | { measured: false; reason: string };

/**
 * Measures the table-precision guard rail for an arm. A guard that can say when
 * its next reading costs nothing exposes `isFree`; that reading skips the budget
 * look-ahead and is taken even after a stop. A guard without it is always
 * checked against the cap, so a guard that forgets to say is never run blind.
 */
export interface TableGuard {
  (arm: LocalizationArm): Promise<TableGuardReading>;
  isFree?: (arm: LocalizationArm) => boolean;
}

/**
 * The CLI's guard: `measureA0` runs once, for A0, and each arm in `others`
 * (#1786: A4, on the split seeding) runs its own measurement once; every
 * reading is memoised for every later corpus. An arm with no measurement wired
 * is answered at no cost. Only an arm's first reading spends money (#1779).
 */
export function memoisedA0TableGuard(
  measureA0: () => Promise<TableGuardReading>,
  others: Readonly<Record<string, () => Promise<TableGuardReading>>> = {},
): TableGuard {
  const measure: Record<string, () => Promise<TableGuardReading>> = { ...others, A0: measureA0 };
  const readings = new Map<string, TableGuardReading>();
  const guard: TableGuard = async (arm) => {
    const run = Object.hasOwn(measure, arm.id) ? measure[arm.id] : undefined;
    if (!run) {
      return { measured: false, reason: `arm ${arm.id} does not wire a table-precision run yet` };
    }
    const memo = readings.get(arm.id) ?? (await run());
    readings.set(arm.id, memo);
    return memo;
  };
  guard.isFree = (arm) => !Object.hasOwn(measure, arm.id) || readings.has(arm.id);
  return guard;
}

/** #1800 — one requirement's score on one run of one arm, as a checkpoint records it. */
export interface RecordedScore {
  arm: string;
  run: number;
  item: string;
  score: ItemRunScore;
  /** What the requirement spent, by the meter (also when the score's cost is null). */
  spentUsd: number;
  /** Unpriced model calls the requirement made. */
  unpricedCalls: number;
}

/** #1800 — scores recorded by earlier calls, and where this call records its own. */
export interface RunCheckpoint {
  recorded: readonly RecordedScore[];
  record(score: RecordedScore): Promise<void>;
}

/** #1800 — the requirements an arm has no score for on a run. */
export interface MissingItems {
  arm: string;
  run: number;
  items: string[];
}

export interface RunLocalizationOptions {
  arms: LocalizationArm[];
  runs?: number;
  /** A fresh cap for this call alone; pass `budget` instead to share one across calls. */
  budgetUsd?: number;
  /** The cap and look-ahead shared across calls (the CLI's corpora). */
  budget?: EvalBudget;
  meter: CostMeter;
  /** Milliseconds; a seam for tests. */
  now?: () => number;
  /** Measures the table-precision guard rail for an arm (the CLI wires impact-recall-01). */
  tableGuard?: TableGuard;
  /** #1800 — the slice: whether this call may RUN an item (default: every item). */
  runItem?: (item: LocalizationItem) => boolean;
  /** #1800 — earlier calls' scores (never re-run), and the sink for this call's. */
  checkpoint?: RunCheckpoint;
  /**
   * #1806 — arms (never A0) every other arm is also paired with (`--reference`).
   * Report-only: they change no score and are not part of the run's fingerprint.
   */
  references?: readonly string[];
}

export interface ArmResult {
  id: string;
  label: string;
  configuration: Record<string, string | number | boolean>;
  /** Complete runs (every item scored). */
  completedRuns: number;
  /** Per item, every run's score, including any the scoring dropped. */
  perItemRuns: Record<string, ItemRunScore[]>;
  /** Run scores left out so every arm is scored on the same runs. */
  droppedRunScores: number;
  items: ItemScore[];
  aggregate: ArmAggregate;
  /** 95% bootstrap interval of each paired metric's mean. */
  intervals: Record<PairedMetric, [number, number]>;
  tableGuard: TableGuardReading;
}

export interface MetricComparison extends PairedDifference {
  metric: PairedMetric;
  verdict: ComparisonVerdict;
}

export interface HitComparison {
  k: 5 | 10;
  /** A0 hit, arm miss. */
  b: number;
  /** A0 miss, arm hit. */
  c: number;
  p: number;
  verdict: ComparisonVerdict;
}

export interface ArmComparison {
  arm: string;
  /** A0, or a `--reference` arm (#1806). */
  baseline: string;
  items: number;
  metrics: MetricComparison[];
  hits: HitComparison[];
  /** null when either reading was not measured. */
  tableGuardPassed: boolean | null;
  /** #1823 — the arm the guard was read against, when not A0 (A7 against A7O). */
  tableGuardAgainst?: string;
}

export interface LocalizationReport {
  kind: "localization-eval";
  corpus: {
    id: string;
    purpose: "held-out" | "in-sample";
    items: number;
    repos: Array<{ name: string; sha: string }>;
  };
  runsRequested: number;
  /**
   * The runs every arm is scored on: the runs ALL arms completed, or the
   * partial first run when none was completed by every arm.
   */
  scoredRuns: number;
  /** True when the scored run is a partial first run: the arms may cover different items. */
  partialFirstRun: boolean;
  budgetUsd: number;
  spentUsd: number;
  /**
   * Where the cap (or an unpriced call) stopped the run; null when it ran to the
   * end. `phase` says whether it stopped before a requirement (`item` names it)
   * or before an arm's table-precision guard (`item` is null). `run` is the run
   * reached: the one the requirement belonged to, or the arm's last complete run.
   */
  stopped: LocalizationStop | null;
  /**
   * #1800 — per arm and run, the requirements with no score: outside the slices
   * run so far, or after a stop. Empty when every arm scored every run.
   */
  missing: MissingItems[];
  arms: ArmResult[];
  comparisons: ArmComparison[];
  /** #1806 — the `--reference` arms, in the order asked for. */
  references: string[];
  /** #1806 — every arm but A0 and the reference, paired with each reference in turn. */
  referenceComparisons: ArmComparison[];
  detectableGap: string;
  /** Caveats a reader must see next to the numbers (e.g. a metric with no signal). */
  notes: string[];
  /**
   * #1810 — where arms that share one agent pass per requirement and run (A3
   * and A3A) read different passes on the scored runs: a resumed slice ran them
   * in separate invocations. Empty when every such pair read one pass.
   */
  splitAgentPasses: SplitAgentPasses[];
}

/** #1810 — arms of one pass group that read different agent passes. */
export interface SplitAgentPasses {
  /** The pass group (`graph`: A3 and A3A). */
  group: string;
  arms: string[];
  readings: Array<{ item: string; run: number }>;
}

/**
 * #1810 — per pass group, the requirement-runs on which the group's arms read
 * different agent passes. In one invocation A3 and A3A read the SAME pass for
 * an item and run; a resume can score one of them in an earlier invocation and
 * the other in a later one, on two passes. Their paired difference there then
 * carries the model's run-to-run variation, so the report must say so.
 */
export function splitAgentPassesOf(
  armIds: readonly string[],
  itemIds: readonly string[],
  runs: number,
  scoreOf: (arm: string, run: number, item: string) => ItemRunScore | undefined,
): SplitAgentPasses[] {
  const byGroup = new Map<string, SplitAgentPasses>();
  for (let run = 1; run <= runs; run++) {
    for (const item of itemIds) {
      const groups = new Map<string, Map<string, string>>();
      for (const arm of armIds) {
        const agent = scoreOf(arm, run, item)?.agent;
        if (!agent) continue;
        if (!groups.has(agent.passGroup)) groups.set(agent.passGroup, new Map());
        groups.get(agent.passGroup)!.set(arm, agent.passIds.join("\u0000"));
      }
      for (const [group, read] of groups) {
        if (new Set(read.values()).size < 2) continue;
        const split = byGroup.get(group) ?? { group, arms: [], readings: [] };
        for (const arm of read.keys()) if (!split.arms.includes(arm)) split.arms.push(arm);
        split.readings.push({ item, run });
        byGroup.set(group, split);
      }
    }
  }
  return [...byGroup.values()];
}

export type LocalizationStop =
  | { phase: "requirement"; reason: string; arm: string; run: number; item: string }
  | { phase: "table-guard"; reason: string; arm: string; run: number; item: null };

/** Run every arm over the corpus, score it and compare it with A0. */
export async function runLocalizationEval(
  corpus: LocalizationCorpus,
  opts: RunLocalizationOptions,
): Promise<LocalizationReport> {
  const runs = opts.runs ?? DEFAULT_RUNS;
  if (!Number.isInteger(runs) || runs < 1) {
    throw new Error(`runs must be a positive integer, not ${runs}`);
  }
  if (opts.budget && opts.budgetUsd !== undefined) {
    throw new Error("pass budgetUsd or a shared budget, not both");
  }
  const budget = opts.budget ?? new EvalBudget(opts.budgetUsd ?? DEFAULT_BUDGET_USD);
  const { meter } = opts;
  const now = opts.now ?? (() => performance.now());
  if (opts.arms[0]?.id !== "A0") throw new Error("A0 must be the first arm: it is the baseline");
  const references = [...(opts.references ?? [])];
  const armIdList = opts.arms.map((a) => a.id);
  for (const ref of references) {
    if (ref === "A0" || !armIdList.includes(ref)) {
      throw new Error(
        ref === "A0"
          ? "--reference A0: every arm is already compared with A0"
          : `--reference ${ref} is not one of this run's arms (${armIdList.join(", ")})`,
      );
    }
  }

  // Per arm, per item, per run: every score held, recorded or new.
  const scores = new Map(
    opts.arms.map((a) => [a.id, new Map<string, Map<number, ItemRunScore>>()]),
  );
  const itemIds = new Set(corpus.manifest.items.map((i) => i.id));
  const hold = (armId: string, run: number, itemId: string, score: ItemRunScore) => {
    const perItem = scores.get(armId)!;
    if (!perItem.has(itemId)) perItem.set(itemId, new Map());
    perItem.get(itemId)!.set(run, score);
  };
  for (const r of opts.checkpoint?.recorded ?? []) {
    if (
      !scores.has(r.arm) ||
      !itemIds.has(r.item) ||
      !Number.isInteger(r.run) ||
      r.run < 1 ||
      r.run > runs
    ) {
      throw new Error(
        `a recorded score (arm ${r.arm}, run ${r.run}, item ${r.item}) is not part of this run's arms, runs or items`,
      );
    }
    hold(r.arm, r.run, r.item, r.score);
  }
  const held = (armId: string, run: number, itemId: string) =>
    scores.get(armId)!.get(itemId)?.has(run) ?? false;
  /** The leading runs on which the arm scored every item. */
  const completedRunsOf = (armId: string) => {
    let n = 0;
    while (n < runs && corpus.manifest.items.every((i) => held(armId, n + 1, i.id))) n++;
    return n;
  };
  let stopped: LocalizationReport["stopped"] = null;

  /**
   * The guard spends money too: it runs under the same cap, and never after a
   * stop — unless it says this reading is free, which spends nothing to refuse.
   */
  async function readTableGuard(arm: LocalizationArm): Promise<TableGuardReading> {
    const guard = opts.tableGuard;
    if (!guard) return { measured: false, reason: "not requested (pass --table-guard)" };
    if (!guard.isFree?.(arm)) {
      if (stopped) {
        return { measured: false, reason: `skipped: the run stopped (${stopped.reason})` };
      }
      const blocked = budget.beforeGuard(meter);
      if (blocked) {
        const run = completedRunsOf(arm.id);
        stopped = { phase: "table-guard", reason: blocked, arm: arm.id, run, item: null };
        return { measured: false, reason: `skipped: ${blocked}` };
      }
    }
    const spent = meter.spentUsd();
    const reading = await guard(arm);
    budget.observeGuard(meter.spentUsd() - spent);
    return reading;
  }

  outer: for (let run = 1; run <= runs; run++) {
    for (const arm of opts.arms) {
      for (const item of corpus.manifest.items) {
        if (held(arm.id, run, item.id)) continue;
        if (opts.runItem && !opts.runItem(item)) continue;
        const blocked = budget.beforeItem(meter, arm.id);
        if (blocked) {
          stopped = { phase: "requirement", reason: blocked, arm: arm.id, run, item: item.id };
          break outer;
        }
        const spent = meter.spentUsd();
        const unpricedBefore = meter.unpricedCalls();
        const t0 = now();
        const out = await arm.localize(item, corpus, { run });
        // #1755 — a reading that reused another arm's model work in this run
        // reports that work's cost and time as its own; the cap sees only spend.
        const seconds = (now() - t0) / 1000 + (out.reusedSeconds ?? 0);
        const itemCost = meter.spentUsd() - spent;
        budget.observeItem(arm.id, itemCost);
        const unpriced = meter.unpricedCalls() > 0 || out.reusedCostUsd === null;
        const score = scoreObservation(
          item.expectedFiles,
          { ...out, costUsd: unpriced ? null : itemCost + (out.reusedCostUsd ?? 0), seconds },
          corpus.graphFiles,
          item.expectedVerdict,
          item.expectedRepos,
        );
        hold(arm.id, run, item.id, score);
        await opts.checkpoint?.record({
          arm: arm.id,
          run,
          item: item.id,
          score,
          spentUsd: itemCost,
          unpricedCalls: meter.unpricedCalls() - unpricedBefore,
        });
      }
    }
  }

  // Score every arm on the runs all of them completed; a partial first run when none did.
  const completed = new Map(opts.arms.map((a) => [a.id, completedRunsOf(a.id)]));
  const commonRuns = Math.min(...completed.values());
  const scoredRuns = Math.max(1, commonRuns);

  const missing: MissingItems[] = [];
  for (const arm of opts.arms) {
    for (let run = 1; run <= runs; run++) {
      const items = corpus.manifest.items.filter((i) => !held(arm.id, run, i.id)).map((i) => i.id);
      if (items.length > 0) missing.push({ arm: arm.id, run, items });
    }
  }

  const arms: ArmResult[] = [];
  for (const arm of opts.arms) {
    const perItem = scores.get(arm.id)!;
    let dropped = 0;
    const items: ItemScore[] = [];
    const perItemRuns: Record<string, ItemRunScore[]> = {};
    for (const i of corpus.manifest.items) {
      const byRun = perItem.get(i.id);
      if (!byRun) continue;
      const ordered = [...byRun].sort(([a], [b]) => a - b);
      perItemRuns[i.id] = ordered.map(([, s]) => s);
      const kept = ordered.filter(([run]) => run <= scoredRuns).map(([, s]) => s);
      dropped += ordered.length - kept.length;
      if (kept.length > 0) items.push(averageRuns(i.id, kept));
    }
    const intervals = Object.fromEntries(
      PAIRED_METRICS.map((m) => [m, bootstrapMeanCi(items.map((s) => s[m]))]),
    ) as Record<PairedMetric, [number, number]>;
    arms.push({
      id: arm.id,
      label: arm.label,
      configuration: arm.configuration,
      completedRuns: completed.get(arm.id)!,
      perItemRuns,
      droppedRunScores: dropped,
      items,
      aggregate: aggregateItems(items),
      intervals,
      tableGuard: await readTableGuard(arm),
    });
  }

  const baseline = arms[0]!;
  const comparisons = arms.slice(1).map((arm) => compareArms(baseline, arm));
  const referenceComparisons = references.flatMap((ref) => {
    const reference = arms.find((a) => a.id === ref)!;
    return arms
      .slice(1)
      .filter((a) => a.id !== ref)
      .map((arm) => compareWithReference(reference, arm));
  });
  return {
    kind: "localization-eval",
    corpus: {
      id: corpus.manifest.id,
      purpose: corpus.manifest.purpose,
      items: corpus.manifest.items.length,
      repos: corpus.manifest.repos.map((r) => ({ name: r.name, sha: r.sha })),
    },
    runsRequested: runs,
    scoredRuns,
    partialFirstRun: commonRuns === 0,
    budgetUsd: budget.budgetUsd,
    spentUsd: meter.spentUsd(),
    stopped,
    missing,
    arms,
    comparisons,
    references,
    referenceComparisons,
    detectableGap: minimumDetectableGapStatement(corpus.manifest.items.length),
    notes: corpusNotes(corpus),
    splitAgentPasses: splitAgentPassesOf(
      opts.arms.map((a) => a.id),
      corpus.manifest.items.map((i) => i.id),
      scoredRuns,
      (armId, run, itemId) => scores.get(armId)!.get(itemId)?.get(run),
    ),
  };
}

/** Caveats that follow from the corpus itself. */
export function corpusNotes(corpus: LocalizationCorpus): string[] {
  const notes: string[] = [];
  const files = corpus.graphFiles.size;
  if (files <= RECALL_AT_10_TRIVIAL_GRAPH_FILES) {
    notes.push(
      `The code graph holds only ${files} files, so an arm that ranks all of them scores ` +
        `Recall@10 = 1.00 by construction: Recall@10 and hit@10 carry no signal on this corpus. ` +
        `Read Recall@5, edit precision and MRR.`,
    );
  }
  return notes;
}

/** The (A0, arm) score pairs of the items both scored, in the arm's order. */
function pairsOf(baseline: ArmResult, arm: ArmResult): Array<readonly [ItemScore, ItemScore]> {
  const base = new Map(baseline.items.map((s) => [s.id, s]));
  return arm.items.filter((s) => base.has(s.id)).map((s) => [base.get(s.id)!, s] as const);
}

type ScorePair = readonly [ItemScore, ItemScore];

/** Paired metric differences over one or more strata of pairs. */
function metricComparisons(strata: ReadonlyArray<readonly ScorePair[]>): MetricComparison[] {
  return PAIRED_METRICS.map((metric): MetricComparison => {
    const d = stratifiedPairedBootstrap(
      strata.map((pairs): PairedStratum => ({
        baseline: pairs.map(([b]) => b[metric]),
        arm: pairs.map(([, a]) => a[metric]),
      })),
    );
    return { metric, ...d, verdict: readDifference(d) };
  });
}

/** Exact McNemar at k = 5 and 10 over pairs (pooled pairs are independent items too). */
function hitComparisons(pairs: readonly ScorePair[]): HitComparison[] {
  return ([5, 10] as const).map((k): HitComparison => {
    const field = k === 5 ? "hitAt5" : "hitAt10";
    // A requirement is a hit when it was hit on at least half of its runs.
    const b = pairs.filter(([x, y]) => x[field] >= 0.5 && y[field] < 0.5).length;
    const c = pairs.filter(([x, y]) => x[field] < 0.5 && y[field] >= 0.5).length;
    const p = mcnemarExact(b, c);
    const verdict: ComparisonVerdict =
      p >= 0.05 ? "no measurable difference" : c > b ? "better" : "worse";
    return { k, b, c, p, verdict };
  });
}

/** Compare an arm with A0 over the items both scored, in corpus order. */
export function compareArms(baseline: ArmResult, arm: ArmResult): ArmComparison {
  const pairs = pairsOf(baseline, arm);
  const metrics = metricComparisons([pairs]);
  const hits = hitComparisons(pairs);
  const g1 = arm.tableGuard;
  // #1786 — gate against A0 on the arm's own seeding when the arm measured it.
  const g0: TableGuardMeasurement | null =
    g1.measured && g1.baseline
      ? g1.baseline
      : baseline.tableGuard.measured
        ? baseline.tableGuard
        : null;
  return {
    arm: arm.id,
    baseline: "A0",
    items: pairs.length,
    metrics,
    hits,
    tableGuardPassed:
      g0 && g1.measured ? g1.tablePrecision >= g0.tablePrecision - TABLE_PRECISION_TOLERANCE : null,
    ...(g0?.arm ? { tableGuardAgainst: g0.arm } : {}),
  };
}

/**
 * #1806 — an arm against a `--reference` arm, with the same paired statistics
 * as {@link compareArms}. The table-precision gate is A0's (no arm may drop
 * table precision below A0's), so a reference pairing does not read it.
 */
export function compareWithReference(reference: ArmResult, arm: ArmResult): ArmComparison {
  const pairs = pairsOf(reference, arm);
  return {
    arm: arm.id,
    baseline: reference.id,
    items: pairs.length,
    metrics: metricComparisons([pairs]),
    hits: hitComparisons(pairs),
    tableGuardPassed: null,
  };
}

// ── Pooled comparison (#1770) ───────────────────────────────────────────────

/** One arm against A0 over the held-out corpora pooled, stratified by corpus. */
export interface PooledComparison {
  arm: string;
  /** A0, or a `--reference` arm (#1806). */
  baseline: string;
  /** The paired items this comparison rests on. */
  items: number;
  strata: Array<{ corpus: string; items: number }>;
  metrics: MetricComparison[];
  hits: HitComparison[];
  /** The gap these paired items can resolve (#1779): fewer than A0 scored when a run stopped. */
  detectableGap: string;
}

export interface PooledLocalizationReport {
  kind: "localization-eval-pooled";
  corpora: Array<{
    id: string;
    items: number;
    scoredRuns: number;
    partialFirstRun: boolean;
    /** Why the corpus's run stopped early (the cap, or an unpriced call); null when it ran to the end. */
    stopped: string | null;
    /** #1800 — requirement scores (arm × run × item) the corpus's report lacks. */
    missingScores: number;
  }>;
  /** A0's scored items over every pooled corpus. */
  items: number;
  comparisons: PooledComparison[];
  /** #1806 — the pairings with each `--reference` arm every held-out report carries. */
  referenceComparisons: PooledComparison[];
  /**
   * The gap the pooled comparison can resolve: on the fewest paired items any
   * comparison rests on, or on A0's items when no arm was compared (#1779).
   */
  detectableGap: string;
}

/**
 * Pool the HELD-OUT reports: one corpus is too small to see the gaps epic #1751
 * sized for, so each arm is also compared with A0 over every held-out item at
 * once. The bootstrap resamples within each corpus (stratified) and McNemar
 * counts the discordant items of all of them. An in-sample report is never
 * pooled: it may not claim a gain.
 */
export function poolHeldOutReports(
  reports: readonly LocalizationReport[],
): PooledLocalizationReport {
  const heldOut = reports.filter((r) => r.corpus.purpose === "held-out");
  if (heldOut.length < 2) {
    throw new Error(`pooling needs two or more held-out reports, got ${heldOut.length}`);
  }
  const armIds = heldOut[0]!.arms
    .slice(1)
    .map((a) => a.id)
    .filter((id) => heldOut.every((r) => r.arms.some((a) => a.id === id)));
  const armOf = (r: LocalizationReport, id: string) => r.arms.find((a) => a.id === id)!;
  const pooledComparison = (baselineId: string, id: string): PooledComparison => {
    const strata = heldOut.map((r) => ({
      corpus: r.corpus.id,
      pairs: pairsOf(armOf(r, baselineId), armOf(r, id)),
    }));
    const pooledPairs = strata.flatMap((s) => s.pairs);
    return {
      arm: id,
      baseline: baselineId,
      items: pooledPairs.length,
      strata: strata.map((s) => ({ corpus: s.corpus, items: s.pairs.length })),
      metrics: metricComparisons(strata.map((s) => s.pairs)),
      hits: hitComparisons(pooledPairs),
      detectableGap: minimumDetectableGapStatement(pooledPairs.length),
    };
  };
  const comparisons = armIds.map((id) => pooledComparison("A0", id));
  // #1806 — a reference is pooled only when every held-out report was read against it.
  const references = heldOut[0]!.references.filter(
    (ref) => armIds.includes(ref) && heldOut.every((r) => r.references.includes(ref)),
  );
  const referenceComparisons = references.flatMap((ref) =>
    armIds.filter((id) => id !== ref).map((id) => pooledComparison(ref, id)),
  );
  const items = heldOut.reduce((sum, r) => sum + r.arms[0]!.items.length, 0);
  const pairedItems = Math.min(items, ...comparisons.map((c) => c.items));
  return {
    kind: "localization-eval-pooled",
    corpora: heldOut.map((r) => ({
      id: r.corpus.id,
      items: r.arms[0]!.items.length,
      scoredRuns: r.scoredRuns,
      partialFirstRun: r.partialFirstRun,
      stopped: r.stopped?.reason ?? null,
      missingScores: r.missing.reduce((n, m) => n + m.items.length, 0),
    })),
    items,
    comparisons,
    referenceComparisons,
    detectableGap: minimumDetectableGapStatement(pairedItems),
  };
}

// ── Rendering ────────────────────────────────────────────────────────────────

const f2 = (x: number) => x.toFixed(2);
const f3 = (x: number) => x.toFixed(3);
const ci = ([lo, hi]: [number, number]) => `[${f2(lo)}, ${f2(hi)}]`;
const money = (x: number | null) => (x === null ? "unpriced" : `$${x.toFixed(4)}`);

/** The paired-metric and McNemar rows of one comparison table. */
function comparisonRows(cmp: {
  arm: string;
  metrics: readonly MetricComparison[];
  hits: readonly HitComparison[];
}): string[] {
  return [
    ...cmp.metrics.map(
      (m) =>
        `| ${cmp.arm} | ${m.metric} | ${m.meanDifference >= 0 ? "+" : ""}${f3(m.meanDifference)} | ${ci(m.ci)} | ${f3(m.p)} | ${m.verdict} |`,
    ),
    ...cmp.hits.map(
      (h) =>
        `| ${cmp.arm} | hit@${h.k} (McNemar, b=${h.b}, c=${h.c}) | ${h.c - h.b >= 0 ? "+" : ""}${h.c - h.b} items | — | ${f3(h.p)} | ${h.verdict} |`,
    ),
  ];
}

/** A human-readable report: configuration first, so no number travels without it. */
export function toMarkdownReport(report: LocalizationReport): string {
  const lines: string[] = [];
  const c = report.corpus;
  lines.push(`# Localization eval — \`${c.id}\``, "");
  if (c.purpose === "in-sample") {
    lines.push(
      "> **IN-SAMPLE.** The `change-seeds.ts` cut sizes were tuned on these requirements. " +
        "This corpus is a sanity check only and is never used to claim a gain.",
      "",
    );
  }
  lines.push(
    `Items: **${c.items}** · Repos: ${c.repos.map((r) => `\`${r.name}@${r.sha.slice(0, 8)}\``).join(", ")} · ` +
      `Runs requested: **${report.runsRequested}** · Budget: **$${report.budgetUsd}** · ` +
      `Spent: **$${report.spentUsd.toFixed(4)}**`,
    "",
  );
  if (report.stopped) {
    const s = report.stopped;
    const where =
      s.phase === "table-guard"
        ? `before arm ${s.arm}'s table-precision guard`
        : `before arm ${s.arm}, run ${s.run}, item ${s.item}`;
    lines.push(`> **Stopped early** (${s.reason}) ${where}.`, "");
  }
  // #1800 — a sliced run, merged before every slice ran, says what it lacks.
  if (report.missing.length > 0) {
    lines.push(
      `> **Missing requirements** (no score yet): ${report.missing
        .map((m) => `${m.arm} run ${m.run}: ${m.items.join(", ")}`)
        .join("; ")}.`,
      "",
    );
  }
  const dropped = report.arms.filter((a) => a.droppedRunScores > 0);
  if (report.partialFirstRun && report.arms.length > 1) {
    lines.push(
      `> **Run 1 is incomplete.** The arms scored different items (${report.arms
        .map((a) => `${a.id}: ${a.items.length}`)
        .join(", ")}); each comparison pairs only the items both arms scored.`,
      "",
    );
  } else if (dropped.length > 0) {
    lines.push(
      `> **Unequal runs.** Every arm is scored on the ${report.scoredRuns} run(s) all arms ` +
        `completed; dropped: ${dropped.map((a) => `${a.id} ${a.droppedRunScores} item score(s)`).join(", ")}.`,
      "",
    );
  }
  for (const note of report.notes) lines.push(`> **Note.** ${note}`, "");
  // #1810 — a resume that split a shared agent pass says where.
  for (const s of report.splitAgentPasses) {
    lines.push(
      `> **Separate agent passes.** ${s.arms.join(" and ")} share one agent pass per requirement ` +
        `and run, but read different passes on ${s.readings.length} requirement-run(s) ` +
        `(${s.readings.map((r) => `${r.item} run ${r.run}`).join(", ")}): a resumed slice ran ` +
        `them in separate invocations. There, their difference includes the model's run-to-run ` +
        `variation, not only what each arm does with the citations.`,
      "",
    );
  }
  lines.push("## Arms", "");
  for (const a of report.arms) {
    lines.push(`### ${a.label}`, "");
    lines.push(`Complete runs: ${a.completedRuns}`, "");
    lines.push("| Setting | Value |", "|---|---|");
    for (const [k, v] of Object.entries(a.configuration)) lines.push(`| ${k} | ${String(v)} |`);
    lines.push("");
  }
  lines.push("## Results (mean over items; 95% bootstrap interval)", "");
  lines.push(
    "| Arm | Recall@5 | Recall@10 | Edit precision | MRR | Graph resolution | Table precision | No edit candidate | Edit files / req | $ / req | s / req |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
  );
  for (const a of report.arms) {
    const g = a.aggregate;
    const t = a.tableGuard;
    // #1786 — an arm read on another seeding shows A0's reading on that seeding beside it.
    const guard = t.measured
      ? `${f3(t.tablePrecision)} (${t.runs} runs${t.baseline ? `; ${t.baseline.arm ?? "A0"} on its seeding ${f3(t.baseline.tablePrecision)}` : ""})`
      : "not measured";
    lines.push(
      `| ${a.id} | ${f2(g.recallAt5)} ${ci(a.intervals.recallAt5)} | ${f2(g.recallAt10)} ${ci(a.intervals.recallAt10)} | ` +
        `${f2(g.editPrecision)} ${ci(a.intervals.editPrecision)} | ${f2(g.mrr)} ${ci(a.intervals.reciprocalRank)} | ` +
        `${g.graphResolution === null ? "n/a (no model-named files)" : f2(g.graphResolution)} | ${guard} | ` +
        `${g.itemsWithNoEditCandidate} | ${f2(g.meanEditCandidates)} | ${money(g.costUsdPerRequirement)} | ` +
        `${g.secondsPerRequirement.toFixed(2)} |`,
    );
  }
  lines.push("");
  // #1755 — an agent arm's turns per requirement, from the agent loop. #1810 —
  // a portfolio runs one pass per repository, and the figure is their sum.
  const agentArms = report.arms.filter((a) => a.aggregate.agentTurnsPerRequirement !== null);
  if (agentArms.length > 0) {
    const summed =
      c.repos.length > 1
        ? ` (summed over the ${c.repos.length} repositories' passes, one pass per repository)`
        : "";
    lines.push(
      `Agent-loop turns per requirement${summed}: ${agentArms
        .map((a) => `${a.id} ${a.aggregate.agentTurnsPerRequirement!.toFixed(1)}`)
        .join(" · ")}`,
      "",
    );
  }
  // #1810 — what the agent passes computed: the Graph resolution column reads
  // 1.00 by construction for an agent arm, because only resolved files are kept.
  const passArms = report.arms.filter((a) => a.aggregate.agent !== null);
  for (const a of passArms) {
    const t = a.aggregate.agent!;
    const resolved = t.citedFiles - t.unresolvedFiles;
    const perPass = (n: number) => (t.passes === 0 ? "n/a" : (n / t.passes).toFixed(1));
    // #1818 — an analysis arm's passes are whole "Evaluate new requirements" runs.
    // #1825 — told by the pass group its readings carry, not by a copy of the arm ids.
    const analysis = Object.values(a.perItemRuns).some((runs) =>
      runs.some((r) => r.agent?.passGroup === ANALYSIS_PASS_GROUP),
    );
    if (analysis) {
      lines.push(
        `- ${a.id} analyses ("Evaluate new requirements"): ${t.passes} over ${t.readings} ` +
          `reading(s), ${t.unanswered} that persisted no requirement (read as the pasted text); ` +
          `stored citations' files in the code graph: ${
            t.citedFiles === 0
              ? "n/a (no citation stored)"
              : `${resolved} of ${t.citedFiles} (${f2(resolved / t.citedFiles)})`
          }.`,
      );
      continue;
    }
    lines.push(
      `- ${a.id} agent passes: ${t.passes} over ${t.readings} reading(s), ` +
        `${t.unanswered} without a schema-valid answer; ${perPass(t.turns)} turns and ` +
        `${perPass(t.toolCalls)} tool calls per pass; cited files in the code graph before the ` +
        `resolve step: ${
          t.citedFiles === 0
            ? "n/a (no file cited)"
            : `${resolved} of ${t.citedFiles} (${f2(resolved / t.citedFiles)})`
        }. The Graph resolution column keeps only resolved files, so it reads 1.00 by construction.`,
    );
  }
  if (passArms.length > 0) lines.push("");
  // #1784 — only a portfolio can name a file outside the answer's repository.
  if (c.repos.length > 1) {
    const confinement = report.arms.map((a) => {
      const r = a.aggregate.repoConfinement;
      return `${a.id} ${r ? `${r.confined}/${r.of}` : "n/a"}`;
    });
    lines.push(
      `Edit candidates only in the answer's repository (items with a one-repository answer): ${confinement.join(" · ")}`,
      "",
    );
  }
  for (const a of report.arms) {
    const g = a.tableGuard;
    if (!g.measured) {
      lines.push(`- ${a.id} table precision: ${g.reason}`);
      continue;
    }
    lines.push(`- ${a.id} table precision (seeding: ${g.seeding}) measured on: ${g.configuration}`);
    // #1786 — the same-seeding reading this arm is gated against (A0's, or #1823 its control's).
    if (g.baseline) {
      lines.push(
        `  - next to ${g.baseline.arm ?? "A0"} on the same seeding (seeding: ${g.baseline.seeding}): ` +
          `${f3(g.baseline.tablePrecision)} (${g.baseline.runs} runs), measured on: ${g.baseline.configuration}`,
      );
    }
  }
  lines.push("");
  lines.push("## Paired comparison with A0", "");
  lines.push(`> ${report.detectableGap}`, "");
  if (report.comparisons.length === 0) {
    lines.push("No other arm was run: this report is A0's baseline.", "");
  } else {
    lines.push("| Arm | Metric | Δ vs A0 | 95% CI | p | Reading |", "|---|---|---|---|---|---|");
    for (const cmp of report.comparisons) {
      lines.push(...comparisonRows(cmp));
      lines.push(
        `| ${cmp.arm} | table precision guard (≤ ${TABLE_PRECISION_TOLERANCE} drop${cmp.tableGuardAgainst ? ` against ${cmp.tableGuardAgainst}` : ""}) | — | — | — | ${
          cmp.tableGuardPassed === null ? "not measured" : cmp.tableGuardPassed ? "held" : "FAILED"
        } |`,
      );
    }
    lines.push("");
  }
  lines.push(...referenceSections(report.references, report.referenceComparisons, ""));
  lines.push("## Per requirement", "");
  lines.push(
    `| Item | ${report.arms.map((a) => `${a.id} R@5 / R@10 / EditP / RR`).join(" | ")} |`,
    `|---|${report.arms.map(() => "---").join("|")}|`,
  );
  const ids = report.arms[0]?.items.map((s) => s.id) ?? [];
  for (const id of ids) {
    const cells = report.arms.map((a) => {
      const s = a.items.find((x) => x.id === id);
      return s
        ? `${f2(s.recallAt5)} / ${f2(s.recallAt10)} / ${f2(s.editPrecision)} / ${f2(s.reciprocalRank)}`
        : "—";
    });
    lines.push(`| ${id} | ${cells.join(" | ")} |`);
  }
  lines.push("");
  return lines.join("\n");
}

/** The pooled comparison as Markdown. */
export function toPooledMarkdownReport(report: PooledLocalizationReport): string {
  const lines: string[] = [];
  lines.push("# Localization eval — held-out corpora pooled", "");
  lines.push(
    `Corpora: ${report.corpora
      .map(
        (c) =>
          `\`${c.id}\` (${c.items} items, ${c.scoredRuns} scored run(s)${c.partialFirstRun ? ", run 1 incomplete" : ""}${c.stopped ? `, stopped early: ${c.stopped}` : ""}${c.missingScores > 0 ? `, ${c.missingScores} requirement score(s) missing` : ""})`,
      )
      .join(", ")} · Items pooled: **${report.items}**`,
    "",
  );
  lines.push(
    "Each arm is compared with A0 over every held-out item at once. The paired bootstrap " +
      "resamples within each corpus, so every replicate keeps each corpus's share of the items; " +
      "McNemar counts the discordant items of all corpora. Table precision is not pooled: read " +
      "it in the per-corpus reports.",
    "",
  );
  lines.push(`> ${report.detectableGap}`, "");
  if (report.comparisons.length === 0) {
    lines.push("No other arm was run: there is nothing to compare with A0.", "");
    return lines.join("\n");
  }
  for (const cmp of report.comparisons) {
    if (cmp.items < report.items) {
      lines.push(
        `> ${cmp.arm} pairs ${cmp.items} of A0's ${report.items} items. ${cmp.detectableGap}`,
        "",
      );
    }
  }
  lines.push("| Arm | Metric | Δ vs A0 | 95% CI | p | Reading |", "|---|---|---|---|---|---|");
  for (const cmp of report.comparisons) {
    lines.push(...comparisonRows(cmp));
  }
  lines.push("");
  const references = [...new Set(report.referenceComparisons.map((c) => c.baseline))];
  lines.push(...referenceSections(references, report.referenceComparisons, ", pooled"));
  return lines.join("\n");
}

/**
 * #1806 — one table per `--reference` arm: every other arm paired with it. The
 * decision bars are read against A0; these tables say what an arm adds over
 * another arm, such as the re-order on A12's base against A12 itself.
 */
function referenceSections(
  references: readonly string[],
  comparisons: ReadonlyArray<{
    arm: string;
    baseline: string;
    metrics: readonly MetricComparison[];
    hits: readonly HitComparison[];
  }>,
  suffix: string,
): string[] {
  const lines: string[] = [];
  for (const ref of references) {
    const rows = comparisons.filter((c) => c.baseline === ref);
    lines.push(`## Paired comparison with ${ref} (\`--reference ${ref}\`)${suffix}`, "");
    if (rows.length === 0) {
      lines.push(`No arm other than A0 and ${ref} was run: there is nothing to pair with it.`, "");
      continue;
    }
    lines.push(
      `| Arm | Metric | Δ vs ${ref} | 95% CI | p | Reading |`,
      "|---|---|---|---|---|---|",
      ...rows.flatMap((cmp) => comparisonRows(cmp)),
      "",
    );
  }
  return lines;
}
