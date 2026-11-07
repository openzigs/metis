/**
 * #1867 — the `pnpm eval:governing` runner: every arm on every requirement,
 * `runs` times, held under one dollar cap, then scored and reported.
 *
 * Spend is metered by the usage ledger's own pricing (`LedgerCostMeter`, as
 * the localization harness does): a call with no price or no reported usage is
 * UNPRICED, and an unpriced call stops the run rather than being counted as $0.
 * Each arm call gets its own metered provider, so every requirement is priced
 * on its own even when `concurrency` runs several at once; while calls are in
 * flight the cap reserves the costliest call seen so far for each of them.
 * An arm that throws on a requirement (a reply with no JSON, a provider error)
 * is recorded as a failure and scored as applying no rule: it is counted in the
 * report, never retried away.
 */
import type { AIProvider, TokenUsage } from "../../ai/types.js";
import { LedgerCostMeter, meterProvider, type CostMeter } from "../localization/cost.js";
import { EvalBudget } from "../localization/runner.js";
import {
  minimumDetectableGapStatement,
  pairedBootstrap,
  readDifference,
  type ComparisonVerdict,
  type PairedDifference,
} from "../localization/stats.js";
import { measureScreenPromptSizes, type GoverningArm, type ScreenPromptSize } from "./arms.js";
import type { GoverningCorpus, GoverningItem } from "./corpus.js";
import {
  checkThresholds,
  scoreItem,
  summarizeRuns,
  type GoverningJudgement,
  type ItemScore,
  type MetricsSummary,
  type PairOutcome,
  type ThresholdCheck,
} from "./scorer.js";

export const DEFAULT_GOVERNING_RUNS = 3;
/** DeepSeek runs the whole A0 baseline for well under a dollar; the cap is a backstop. */
export const DEFAULT_GOVERNING_BUDGET_USD = 5;
/** The rule counts the summary screen's prompt is measured at (#1867). */
export const SCREEN_SIZE_RULE_COUNTS = [40, 200, 500] as const;

/** The ledger meter, also summing the tokens it prices. */
export class TokenLedgerMeter extends LedgerCostMeter {
  private input = 0;
  private completion = 0;

  override record(provider: string, model: string, usage: TokenUsage | undefined): number | null {
    if (usage) {
      // The Anthropic wire's `input_tokens` excludes the cache fields, and the
      // providers that report a cache read report it apart, so every input
      // token the call sent is the sum of the three.
      this.input +=
        usage.promptTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
      this.completion += usage.completionTokens;
    }
    return super.record(provider, model, usage);
  }

  /** Every input token sent: fresh, cache read and cache write. */
  inputTokens(): number {
    return this.input;
  }

  completionTokens(): number {
    return this.completion;
  }
}

/**
 * The spend of every finished call, and a reserve for the calls in flight:
 * what the cap reads ({@link SpendLedger.capView}).
 */
export class SpendLedger {
  private usd = 0;
  private unpriced = 0;
  private inFlight = 0;
  private maxCallUsd = 0;

  begin(): void {
    this.inFlight++;
  }

  /** Close one call and add what its meter recorded. */
  end(call: TokenLedgerMeter): void {
    this.inFlight--;
    this.usd += call.spentUsd();
    this.unpriced += call.unpricedCalls();
    this.maxCallUsd = Math.max(this.maxCallUsd, call.spentUsd());
  }

  committedUsd(): number {
    return this.usd;
  }

  reservedUsd(): number {
    return this.inFlight * this.maxCallUsd;
  }

  unpricedCalls(): number {
    return this.unpriced;
  }

  /** Spent plus reserved: the meter the cap is checked against. */
  capView(): CostMeter {
    return {
      spentUsd: () => this.committedUsd() + this.reservedUsd(),
      unpricedCalls: () => this.unpricedCalls(),
    };
  }
}

/** One arm on one requirement in one run. */
export interface ItemRunRecord {
  itemId: string;
  run: number;
  judgements: GoverningJudgement[];
  diagnostics?: Record<string, number>;
  /** Set when the arm threw; the requirement is then scored as applying no rule. */
  error?: string;
  /** What this call spent; null when any of its model calls was unpriced. */
  costUsd: number | null;
  inputTokens: number;
  completionTokens: number;
  seconds: number;
  pairs: PairOutcome[];
}

export interface ArmCost {
  totalUsd: number | null;
  usdPerRequirement: number | null;
  inputTokensPerRequirement: number;
  completionTokensPerRequirement: number;
  secondsPerRequirement: number;
}

export interface GoverningArmReport {
  id: string;
  label: string;
  configuration: Record<string, string | number | boolean>;
  /** Runs in which every requirement was assessed; only these are scored. */
  completedRuns: number;
  summary: MetricsSummary;
  thresholds: ThresholdCheck[];
  cost: ArmCost;
  failures: number;
  records: ItemRunRecord[];
}

/** An arm compared with A0 on the same requirements. */
export interface ArmComparison {
  arm: string;
  metric: "recall" | "nonResemblingRecall";
  difference: PairedDifference;
  verdict: ComparisonVerdict;
}

export interface GoverningReport {
  corpus: {
    id: string;
    items: number;
    rules: number;
    policy: string;
    revision: string;
    reviewedBy: string | null;
  };
  thresholds: GoverningCorpus["manifest"]["thresholds"];
  runsRequested: number;
  budgetUsd: number;
  spentUsd: number;
  unpricedCalls: number;
  stopped: { reason: string; arm: string; itemId: string; run: number } | null;
  arms: GoverningArmReport[];
  comparisons: ArmComparison[];
  detectableGap: string;
  screenPromptSizes: ScreenPromptSize[];
}

export interface GoverningRunOptions {
  arms: readonly GoverningArm[];
  runs: number;
  budget: EvalBudget;
  /** The live provider, unmetered: the runner meters each call itself. */
  provider: AIProvider;
  /** Requirements assessed at once within a run (default 1). */
  concurrency?: number;
  /** Milliseconds; a seam for tests. */
  now?: () => number;
  log?: (line: string) => void;
}

function costOf(records: readonly ItemRunRecord[]): ArmCost {
  const n = records.length;
  const unpriced = records.some((r) => r.costUsd === null);
  const total = records.reduce((s, r) => s + (r.costUsd ?? 0), 0);
  const per = (f: (r: ItemRunRecord) => number) =>
    n === 0 ? 0 : records.reduce((s, r) => s + f(r), 0) / n;
  return {
    totalUsd: unpriced ? null : total,
    usdPerRequirement: unpriced || n === 0 ? null : total / n,
    inputTokensPerRequirement: per((r) => r.inputTokens),
    completionTokensPerRequirement: per((r) => r.completionTokens),
    secondsPerRequirement: per((r) => r.seconds),
  };
}

/** Per-item recall (or non-resembling recall) averaged over runs; null for an item with none to find. */
function perItemRecall(
  scoresByRun: ReadonlyArray<readonly ItemScore[]>,
  metric: ArmComparison["metric"],
): Array<number | null> {
  const items = scoresByRun[0]?.length ?? 0;
  return Array.from({ length: items }, (_, i) => {
    const [num, den] =
      metric === "recall"
        ? (["truePositives", "truth"] as const)
        : (["nonResemblingFound", "nonResemblingTruth"] as const);
    const d = scoresByRun[0]![i]![den];
    if (d === 0) return null;
    return scoresByRun.reduce((s, run) => s + run[i]![num] / d, 0) / scoresByRun.length;
  });
}

/** Each arm's recall and non-resembling recall against A0, paired over the same items and runs. */
export function compareWithA0(
  scored: ReadonlyMap<string, ReadonlyArray<readonly ItemScore[]>>,
): ArmComparison[] {
  const base = scored.get("A0");
  if (!base || base.length === 0) return [];
  const out: ArmComparison[] = [];
  for (const [arm, runs] of scored) {
    if (arm === "A0" || runs.length === 0) continue;
    const common = Math.min(base.length, runs.length);
    for (const metric of ["recall", "nonResemblingRecall"] as const) {
      const a = perItemRecall(base.slice(0, common), metric);
      const b = perItemRecall(runs.slice(0, common), metric);
      const keep = a.map((v, i) => v !== null && b[i] !== null);
      const difference = pairedBootstrap(
        a.filter((_, i) => keep[i]) as number[],
        b.filter((_, i) => keep[i]) as number[],
      );
      out.push({ arm, metric, difference, verdict: readDifference(difference) });
    }
  }
  return out;
}

/**
 * Run every arm over every requirement `runs` times. Stops, and says why, at
 * the first requirement the cap (or an unpriced call) refuses.
 */
export async function runGoverningEval(
  corpus: GoverningCorpus,
  opts: GoverningRunOptions,
): Promise<GoverningReport> {
  const now = opts.now ?? Date.now;
  const items = corpus.manifest.items;
  const order = new Map(items.map((item, i) => [item.id, i]));
  const records = new Map<string, ItemRunRecord[]>(opts.arms.map((a) => [a.id, []]));
  const ledger = new SpendLedger();
  const cap = ledger.capView();
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? 1));
  let stopped: GoverningReport["stopped"] = null;

  const assessOne = async (arm: GoverningArm, item: GoverningItem, run: number) => {
    const callMeter = new TokenLedgerMeter();
    const t0 = now();
    let judgements: GoverningJudgement[] = [];
    let diagnostics: Record<string, number> | undefined;
    let error: string | undefined;
    ledger.begin();
    try {
      const out = await arm.assess(item, corpus, {
        provider: meterProvider(opts.provider, callMeter),
      });
      judgements = out.judgements;
      diagnostics = out.diagnostics;
    } catch (err) {
      // One line, bounded: a schema error message is a multi-line JSON dump.
      error = (err instanceof Error ? err.message : String(err))
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 300);
      opts.log?.(`[${arm.id}] ${item.id} run ${run} failed: ${error}`);
    } finally {
      ledger.end(callMeter);
    }
    const costUsd = callMeter.unpricedCalls() > 0 ? null : callMeter.spentUsd();
    if (costUsd !== null) opts.budget.observeItem(arm.id, costUsd);
    records.get(arm.id)!.push({
      itemId: item.id,
      run,
      judgements,
      ...(diagnostics ? { diagnostics } : {}),
      ...(error !== undefined ? { error } : {}),
      costUsd,
      inputTokens: callMeter.inputTokens(),
      completionTokens: callMeter.completionTokens(),
      seconds: (now() - t0) / 1000,
      pairs: scoreItem(corpus, item, { judgements }).pairs,
    });
  };

  for (let run = 1; run <= opts.runs && !stopped; run++) {
    let next = 0;
    const worker = async (): Promise<void> => {
      while (!stopped && next < items.length) {
        const item = items[next++]!;
        for (const arm of opts.arms) {
          if (stopped) return;
          const blocked = opts.budget.beforeItem(cap, arm.id);
          if (blocked) {
            stopped = { reason: blocked, arm: arm.id, itemId: item.id, run };
            return;
          }
          await assessOne(arm, item, run);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
    if (!stopped) {
      opts.log?.(`run ${run} of ${opts.runs} done ($${ledger.committedUsd().toFixed(4)} so far)`);
    }
  }
  for (const recs of records.values()) {
    recs.sort((a, b) => a.run - b.run || order.get(a.itemId)! - order.get(b.itemId)!);
  }

  const scored = new Map<string, ItemScore[][]>();
  const arms: GoverningArmReport[] = opts.arms.map((arm) => {
    const recs = records.get(arm.id)!;
    const runsScored: ItemScore[][] = [];
    for (let run = 1; run <= opts.runs; run++) {
      const inRun = recs.filter((r) => r.run === run);
      if (inRun.length !== items.length) break;
      runsScored.push(items.map((item, i) => scoreItem(corpus, item, inRun[i]!)));
    }
    scored.set(arm.id, runsScored);
    const summary = summarizeRuns(runsScored);
    return {
      id: arm.id,
      label: arm.label,
      configuration: arm.configuration,
      completedRuns: runsScored.length,
      summary,
      thresholds: checkThresholds(summary, corpus.manifest.thresholds),
      cost: costOf(recs),
      failures: recs.filter((r) => r.error !== undefined).length,
      records: recs,
    };
  });

  return {
    corpus: {
      id: corpus.name,
      items: items.length,
      rules: corpus.rules.length,
      policy: corpus.policyFile,
      revision: corpus.manifest.policy.scored,
      reviewedBy: corpus.manifest.annotation.reviewedBy,
    },
    thresholds: corpus.manifest.thresholds,
    runsRequested: opts.runs,
    budgetUsd: opts.budget.budgetUsd,
    spentUsd: ledger.committedUsd(),
    unpricedCalls: ledger.unpricedCalls(),
    stopped,
    arms,
    comparisons: compareWithA0(scored),
    detectableGap: minimumDetectableGapStatement(items.filter((i) => i.applies.length > 0).length),
    screenPromptSizes: measureScreenPromptSizes(corpus, SCREEN_SIZE_RULE_COUNTS),
  };
}

/**
 * The report as committed JSON: indented, but one line per arm record so a
 * baseline of 36 requirements × 3 runs stays readable in a diff. A record's
 * `pairs` are left out: `scoreItem` recomputes them from its judgements and
 * the corpus, and they would more than double the file.
 */
export function toJsonReport(report: GoverningReport, extra: Record<string, unknown> = {}): string {
  const records = report.arms.map((a) => a.records);
  const marker = (i: number) => `__GOVERNING_RECORDS_${i}__`;
  const body = JSON.stringify(
    { ...report, arms: report.arms.map((a, i) => ({ ...a, records: marker(i) })), ...extra },
    null,
    2,
  );
  const withRecords = records.reduce((text, recs, i) => {
    const lines = recs.map(({ pairs: _pairs, ...r }) => `      ${JSON.stringify(r)}`);
    const block = lines.length === 0 ? "[]" : `[\n${lines.join(",\n")}\n    ]`;
    return text.replace(`"${marker(i)}"`, () => block);
  }, body);
  return `${withRecords}\n`;
}

const pct = (v: number | null) => (v === null ? "n/a" : v.toFixed(2));
const ci = (s: { mean: number | null; ci: [number, number] | null }) =>
  s.mean === null ? "n/a" : `${pct(s.mean)}${s.ci ? ` [${pct(s.ci[0])}, ${pct(s.ci[1])}]` : ""}`;

/** Truth pairs an arm missed in every scored run, and every hard error, for the report. */
function misses(arm: GoverningArmReport): { missed: string[]; hardErrors: string[] } {
  const scoredRuns = new Set(Array.from({ length: arm.completedRuns }, (_, i) => i + 1));
  const recs = arm.records.filter((r) => scoredRuns.has(r.run));
  const missedCount = new Map<string, number>();
  const hardErrors: string[] = [];
  for (const r of recs) {
    for (const p of r.pairs) {
      if (p.truth !== null && p.verdict === null && p.nonResembling) {
        const key = `${r.itemId} → ${p.ruleId}`;
        missedCount.set(key, (missedCount.get(key) ?? 0) + 1);
      }
      if (p.hardError) hardErrors.push(`${r.itemId} → ${p.ruleId} (run ${r.run})`);
    }
  }
  const missed = [...missedCount]
    .filter(([, n]) => n === arm.completedRuns)
    .map(([k]) => k)
    .sort();
  return { missed, hardErrors };
}

export function toMarkdownReport(report: GoverningReport): string {
  const lines: string[] = [];
  const c = report.corpus;
  lines.push(`# Governing-rules eval — \`${c.id}\``, "");
  lines.push(
    `Requirements: **${c.items}** · Rules: **${c.rules}** (\`${c.policy}\`, revision ${c.revision}) · ` +
      `Runs requested: **${report.runsRequested}** · Budget: **$${report.budgetUsd}** · ` +
      `Spent: **$${report.spentUsd.toFixed(4)}**` +
      (report.unpricedCalls > 0 ? ` · **${report.unpricedCalls} unpriced call(s)**` : ""),
    "",
  );
  if (report.stopped) {
    lines.push(
      `> **Stopped** before ${report.stopped.arm} on ${report.stopped.itemId} (run ${report.stopped.run}): ${report.stopped.reason}`,
      "",
    );
  }
  lines.push(
    `Labels: ${c.reviewedBy ? `reviewed by ${c.reviewedBy}` : "**not yet reviewed by a person** (see ANNOTATION.md)"}.`,
    "",
  );
  lines.push("## Results (mean over runs; 95% bootstrap interval over requirements)", "");
  lines.push(
    "| Arm | Runs | Recall | Non-resembling recall | Precision | Citation accuracy | Citation coverage | Verdict accuracy | Hard errors | Ask rate | Clean negatives | Failures | $ / req | Tokens in / out per req | s / req |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  );
  for (const a of report.arms) {
    const m = a.summary.metrics;
    const usd = a.cost.usdPerRequirement;
    lines.push(
      `| ${a.id} | ${a.completedRuns} | ${ci(m.recall)} | ${ci(m.nonResemblingRecall)} | ${ci(m.precision)} | ` +
        `${ci(m.citationAccuracy)} | ${ci(m.citationCoverage)} | ${ci(m.verdictAccuracy)} | ` +
        `${a.summary.hardErrors} | ${ci(m.askRate)} | ` +
        `${a.summary.cleanNegatives.join("/") || "n/a"} of ${a.summary.negatives} | ${a.failures} | ` +
        `${usd === null ? "unpriced" : `$${usd.toFixed(4)}`} | ` +
        `${Math.round(a.cost.inputTokensPerRequirement)} / ${Math.round(a.cost.completionTokensPerRequirement)} | ` +
        `${a.cost.secondsPerRequirement.toFixed(1)} |`,
    );
  }
  lines.push("");
  lines.push(
    "Hard errors: `compliant` on a pair whose truth is `gap` or `needs-ba-input`, summed over runs. " +
      "Clean negatives: negative requirements on which the arm applied no rule, per run.",
    "",
  );
  lines.push(
    `## Proposed pass thresholds (${report.thresholds.status}, ${report.thresholds.proposedIn})`,
    "",
  );
  lines.push("| Arm | Bar | Required | Measured | Pass |", "|---|---|---|---|---|");
  for (const a of report.arms) {
    for (const t of a.thresholds) {
      lines.push(
        `| ${a.id} | ${t.bar} | ${t.required} | ${t.measured} | ${t.pass ? "yes" : "**no**"} |`,
      );
    }
  }
  lines.push("");
  lines.push("## Paired comparison with A0", "", `> ${report.detectableGap}`, "");
  if (report.comparisons.length === 0) {
    lines.push("No other arm was run: this report is A0's baseline.", "");
  } else {
    lines.push("| Arm | Metric | Δ vs A0 | 95% CI | p | Reading |", "|---|---|---|---|---|---|");
    for (const cmp of report.comparisons) {
      const d = cmp.difference;
      lines.push(
        `| ${cmp.arm} | ${cmp.metric} | ${d.meanDifference >= 0 ? "+" : ""}${d.meanDifference.toFixed(2)} | ` +
          `[${d.ci[0].toFixed(2)}, ${d.ci[1].toFixed(2)}] | ${d.p.toFixed(3)} | ${cmp.verdict} (n=${d.n}) |`,
      );
    }
    lines.push("");
  }
  lines.push("## Summary-screen prompt size", "");
  lines.push("| Rules | Characters | Estimated tokens |", "|---|---|---|");
  for (const s of report.screenPromptSizes) {
    lines.push(`| ${s.rules} | ${s.chars} | ${s.estimatedTokens} |`);
  }
  lines.push(
    "",
    "Estimated at the repository's 4-characters-per-token heuristic; no model was called.",
    "",
  );
  lines.push("## Arms", "");
  for (const a of report.arms) {
    lines.push(`### ${a.label}`, "", "| Setting | Value |", "|---|---|");
    for (const [k, v] of Object.entries(a.configuration)) lines.push(`| ${k} | ${String(v)} |`);
    const { missed, hardErrors } = misses(a);
    lines.push("");
    lines.push(
      `Non-resembling pairs missed in every run: ${missed.length === 0 ? "none" : missed.join("; ")}.`,
      "",
      `Hard errors: ${hardErrors.length === 0 ? "none" : hardErrors.join("; ")}.`,
      "",
    );
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
