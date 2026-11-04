/**
 * #1753 — run arms over a localization corpus, score them, and compare each
 * with A0 on the same items.
 *
 * Runs are RUN-MAJOR (every arm finishes run 1 before any starts run 2), so a
 * run the dollar cap stops leaves every arm with the same number of complete
 * runs. The cap is checked before each requirement against what has been spent
 * plus the most one requirement has cost so far, so the run stops BEFORE it
 * would exceed the budget, not after. An unpriced call stops it too: unknown
 * spend cannot be held under a cap.
 *
 * Pure orchestration over injected arms, meter and clock: no environment
 * reads, no network of its own.
 */
import type { LocalizationArm } from "./arms.js";
import type { LocalizationCorpus } from "./corpus.js";
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
  pairedBootstrap,
  readDifference,
  type ComparisonVerdict,
  type PairedDifference,
} from "./stats.js";

/** Default runs per arm: the arms with a model in the loop are not deterministic. */
export const DEFAULT_RUNS = 3;
/** Default dollar cap for one invocation. */
export const DEFAULT_BUDGET_USD = 35;
/** The table-precision guard rail: no arm may drop it more than this below A0. */
export const TABLE_PRECISION_TOLERANCE = 0.03;

/** The table-precision guard rail reading for one arm. */
export type TableGuardReading =
  | { measured: true; tablePrecision: number; runs: number; configuration: string }
  | { measured: false; reason: string };

export interface RunLocalizationOptions {
  arms: LocalizationArm[];
  runs?: number;
  budgetUsd?: number;
  meter: CostMeter;
  /** Milliseconds; a seam for tests. */
  now?: () => number;
  /** Measures the table-precision guard rail for an arm (the CLI wires impact-recall-01). */
  tableGuard?: (arm: LocalizationArm) => Promise<TableGuardReading>;
}

export interface ArmResult {
  id: string;
  label: string;
  configuration: Record<string, string | number | boolean>;
  /** Complete runs (every item scored). */
  completedRuns: number;
  /** Per item, every run's score. */
  perItemRuns: Record<string, ItemRunScore[]>;
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
  baseline: "A0";
  items: number;
  metrics: MetricComparison[];
  hits: HitComparison[];
  /** null when either reading was not measured. */
  tableGuardPassed: boolean | null;
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
  budgetUsd: number;
  spentUsd: number;
  /** Where the cap (or an unpriced call) stopped the run; null when it ran to the end. */
  stopped: { reason: string; arm: string; run: number; item: string } | null;
  arms: ArmResult[];
  comparisons: ArmComparison[];
  detectableGap: string;
}

/** Run every arm over the corpus, score it and compare it with A0. */
export async function runLocalizationEval(
  corpus: LocalizationCorpus,
  opts: RunLocalizationOptions,
): Promise<LocalizationReport> {
  const runs = Math.max(1, Math.floor(opts.runs ?? DEFAULT_RUNS));
  const budgetUsd = opts.budgetUsd ?? DEFAULT_BUDGET_USD;
  const now = opts.now ?? (() => performance.now());
  if (opts.arms[0]?.id !== "A0") throw new Error("A0 must be the first arm: it is the baseline");

  const perArm = new Map(
    opts.arms.map((a) => [a.id, { completedRuns: 0, perItem: new Map<string, ItemRunScore[]>() }]),
  );
  let stopped: LocalizationReport["stopped"] = null;
  let maxItemCost = 0;

  outer: for (let run = 1; run <= runs; run++) {
    for (const arm of opts.arms) {
      const state = perArm.get(arm.id)!;
      for (const item of corpus.manifest.items) {
        const spent = opts.meter.spentUsd();
        if (opts.meter.unpricedCalls() > 0) {
          stopped = { reason: "an unpriced model call", arm: arm.id, run, item: item.id };
          break outer;
        }
        if (spent + maxItemCost > budgetUsd) {
          stopped = {
            reason: `budget: $${spent.toFixed(4)} spent + up to $${maxItemCost.toFixed(4)} next > $${budgetUsd}`,
            arm: arm.id,
            run,
            item: item.id,
          };
          break outer;
        }
        const t0 = now();
        const out = await arm.localize(item, corpus);
        const seconds = (now() - t0) / 1000;
        const itemCost = opts.meter.spentUsd() - spent;
        maxItemCost = Math.max(maxItemCost, itemCost);
        const unpriced = opts.meter.unpricedCalls() > 0;
        const score = scoreObservation(
          item.expectedFiles,
          { ...out, costUsd: unpriced ? null : itemCost, seconds },
          corpus.graphFiles,
          item.expectedVerdict,
        );
        state.perItem.set(item.id, [...(state.perItem.get(item.id) ?? []), score]);
      }
      state.completedRuns = run;
    }
  }

  const arms: ArmResult[] = [];
  for (const arm of opts.arms) {
    const state = perArm.get(arm.id)!;
    const items = corpus.manifest.items
      .filter((i) => (state.perItem.get(i.id)?.length ?? 0) > 0)
      .map((i) => averageRuns(i.id, state.perItem.get(i.id)!));
    const intervals = Object.fromEntries(
      PAIRED_METRICS.map((m) => [m, bootstrapMeanCi(items.map((s) => s[m]))]),
    ) as Record<PairedMetric, [number, number]>;
    arms.push({
      id: arm.id,
      label: arm.label,
      configuration: arm.configuration,
      completedRuns: state.completedRuns,
      perItemRuns: Object.fromEntries(state.perItem),
      items,
      aggregate: aggregateItems(items),
      intervals,
      tableGuard: opts.tableGuard
        ? await opts.tableGuard(arm)
        : { measured: false, reason: "not requested (pass --table-guard)" },
    });
  }

  const baseline = arms[0]!;
  const comparisons = arms.slice(1).map((arm) => compareArms(baseline, arm));
  return {
    kind: "localization-eval",
    corpus: {
      id: corpus.manifest.id,
      purpose: corpus.manifest.purpose,
      items: corpus.manifest.items.length,
      repos: corpus.manifest.repos.map((r) => ({ name: r.name, sha: r.sha })),
    },
    runsRequested: runs,
    budgetUsd,
    spentUsd: opts.meter.spentUsd(),
    stopped,
    arms,
    comparisons,
    detectableGap: minimumDetectableGapStatement(corpus.manifest.items.length),
  };
}

/** Compare an arm with A0 over the items both scored, in corpus order. */
export function compareArms(baseline: ArmResult, arm: ArmResult): ArmComparison {
  const base = new Map(baseline.items.map((s) => [s.id, s]));
  const pairs = arm.items.filter((s) => base.has(s.id)).map((s) => [base.get(s.id)!, s] as const);
  const metrics = PAIRED_METRICS.map((metric): MetricComparison => {
    const d = pairedBootstrap(
      pairs.map(([b]) => b[metric]),
      pairs.map(([, a]) => a[metric]),
    );
    return { metric, ...d, verdict: readDifference(d) };
  });
  const hits = ([5, 10] as const).map((k): HitComparison => {
    const field = k === 5 ? "hitAt5" : "hitAt10";
    // A requirement is a hit when it was hit on at least half of its runs.
    const b = pairs.filter(([x, y]) => x[field] >= 0.5 && y[field] < 0.5).length;
    const c = pairs.filter(([x, y]) => x[field] < 0.5 && y[field] >= 0.5).length;
    const p = mcnemarExact(b, c);
    const verdict: ComparisonVerdict =
      p >= 0.05 ? "no measurable difference" : c > b ? "better" : "worse";
    return { k, b, c, p, verdict };
  });
  const g0 = baseline.tableGuard;
  const g1 = arm.tableGuard;
  return {
    arm: arm.id,
    baseline: "A0",
    items: pairs.length,
    metrics,
    hits,
    tableGuardPassed:
      g0.measured && g1.measured
        ? g1.tablePrecision >= g0.tablePrecision - TABLE_PRECISION_TOLERANCE
        : null,
  };
}

// ── Rendering ────────────────────────────────────────────────────────────────

const f2 = (x: number) => x.toFixed(2);
const f3 = (x: number) => x.toFixed(3);
const ci = ([lo, hi]: [number, number]) => `[${f2(lo)}, ${f2(hi)}]`;
const money = (x: number | null) => (x === null ? "unpriced" : `$${x.toFixed(4)}`);

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
    lines.push(
      `> **Stopped early** (${s.reason}) before arm ${s.arm}, run ${s.run}, item ${s.item}.`,
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
    const guard = a.tableGuard.measured
      ? `${f3(a.tableGuard.tablePrecision)} (${a.tableGuard.runs} runs)`
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
  for (const a of report.arms) {
    if (!a.tableGuard.measured) lines.push(`- ${a.id} table precision: ${a.tableGuard.reason}`);
    else lines.push(`- ${a.id} table precision measured on: ${a.tableGuard.configuration}`);
  }
  lines.push("");
  lines.push("## Paired comparison with A0", "");
  lines.push(`> ${report.detectableGap}`, "");
  if (report.comparisons.length === 0) {
    lines.push("No other arm was run: this report is A0's baseline.", "");
  } else {
    lines.push("| Arm | Metric | Δ vs A0 | 95% CI | p | Reading |", "|---|---|---|---|---|---|");
    for (const cmp of report.comparisons) {
      for (const m of cmp.metrics) {
        lines.push(
          `| ${cmp.arm} | ${m.metric} | ${m.meanDifference >= 0 ? "+" : ""}${f3(m.meanDifference)} | ${ci(m.ci)} | ${f3(m.p)} | ${m.verdict} |`,
        );
      }
      for (const h of cmp.hits) {
        lines.push(
          `| ${cmp.arm} | hit@${h.k} (McNemar, b=${h.b}, c=${h.c}) | ${h.c - h.b >= 0 ? "+" : ""}${h.c - h.b} items | — | ${f3(h.p)} | ${h.verdict} |`,
        );
      }
      lines.push(
        `| ${cmp.arm} | table precision guard (≤ ${TABLE_PRECISION_TOLERANCE} drop) | — | — | — | ${
          cmp.tableGuardPassed === null ? "not measured" : cmp.tableGuardPassed ? "held" : "FAILED"
        } |`,
      );
    }
    lines.push("");
  }
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
