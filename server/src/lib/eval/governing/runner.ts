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
 * Before any call has finished, that reserve (and the next call's allowance) is
 * a per-call estimate ({@link estimateCallUsd}), so the first concurrent wave
 * cannot run past the cap either (#1900).
 * An arm that throws on a requirement (a reply with no JSON, a provider error)
 * is recorded as a failure and scored as an error: its truth pairs are misses,
 * and a negative requirement it failed on is not a clean negative. It is
 * counted in the report, never retried away.
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
  heldByConstruction,
  scoreItem,
  summarizeRuns,
  type ByConstruction,
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
  private maxCallUsd: number;

  /**
   * @param estimatedCallUsd what one call is expected to cost: the reserve for
   *   each call in flight until a finished call shows a costlier one.
   */
  constructor(estimatedCallUsd = 0) {
    this.maxCallUsd = estimatedCallUsd;
  }

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

/**
 * The tokens one arm call is estimated at: about twice what A0 spent per
 * requirement in its committed baseline (2,386 in / 2,689 out on DeepSeek),
 * since A2 makes two calls.
 */
export const ESTIMATED_CALL_TOKENS = { input: 6_000, output: 6_000 } as const;

/**
 * #1900 — one arm call at {@link ESTIMATED_CALL_TOKENS}, priced by the ledger
 * for the provider's model; 0 when the model has no price (its first call
 * then stops the run as unpriced).
 */
export function estimateCallUsd(provider: Pick<AIProvider, "key" | "model">): number {
  const meter = new LedgerCostMeter();
  const { input, output } = ESTIMATED_CALL_TOKENS;
  const usd = meter.record(provider.key, provider.model, {
    promptTokens: input,
    completionTokens: output,
    totalTokens: input + output,
  });
  return usd ?? 0;
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
  /** The metrics the arm fixes by construction, reported `n/a` (#1900). */
  byConstruction: ByConstruction;
  /** Runs in which every requirement was assessed; only these are scored. */
  completedRuns: number;
  summary: MetricsSummary;
  thresholds: ThresholdCheck[];
  cost: ArmCost;
  failures: number;
  records: ItemRunRecord[];
}

/** The per-item ratios compared with A0, each with its numerator and denominator. */
const COMPARED = {
  recall: ["truePositives", "truth"],
  nonResemblingRecall: ["nonResemblingFound", "nonResemblingTruth"],
  // #1920 — A0's citation accuracy is fixed by construction, so its quoting is
  // read from coverage; an arm's own accuracy bar keeps coverage honest.
  citationCoverage: ["cited", "applied"],
} as const satisfies Record<string, readonly [keyof ItemScore, keyof ItemScore]>;

/** An arm compared with A0 on the same requirements. */
export interface ArmComparison {
  arm: string;
  metric: keyof typeof COMPARED;
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
  /** What one arm call is expected to cost; default {@link estimateCallUsd} of `provider`. */
  callEstimateUsd?: number;
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

/**
 * Per-item ratio, its counts pooled over runs; null for an item with no
 * denominator in any run. A recall's denominator is the same in every run, so
 * this is the run-mean of the item's recall.
 */
function perItemRatio(
  scoresByRun: ReadonlyArray<readonly ItemScore[]>,
  metric: ArmComparison["metric"],
): Array<number | null> {
  const items = scoresByRun[0]?.length ?? 0;
  const [num, den] = COMPARED[metric];
  return Array.from({ length: items }, (_, i) => {
    const d = scoresByRun.reduce((s, run) => s + run[i]![den], 0);
    if (d === 0) return null;
    return scoresByRun.reduce((s, run) => s + run[i]![num], 0) / d;
  });
}

/**
 * Each arm's recall, non-resembling recall and citation coverage against A0,
 * paired over the same items and runs (an item counts where both are defined).
 */
export function compareWithA0(
  scored: ReadonlyMap<string, ReadonlyArray<readonly ItemScore[]>>,
): ArmComparison[] {
  const base = scored.get("A0");
  if (!base || base.length === 0) return [];
  const out: ArmComparison[] = [];
  for (const [arm, runs] of scored) {
    if (arm === "A0" || runs.length === 0) continue;
    const common = Math.min(base.length, runs.length);
    for (const metric of Object.keys(COMPARED) as Array<ArmComparison["metric"]>) {
      const a = perItemRatio(base.slice(0, common), metric);
      const b = perItemRatio(runs.slice(0, common), metric);
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
  const callEstimateUsd = opts.callEstimateUsd ?? estimateCallUsd(opts.provider);
  // #1920 — NaN would spread into the reserve and the allowance and switch the
  // cap off; a negative estimate would shrink the first wave's reserve.
  if (!Number.isFinite(callEstimateUsd) || callEstimateUsd < 0) {
    throw new Error(
      `the per-call estimate must be a non-negative number of dollars, not ${callEstimateUsd}`,
    );
  }
  // Until a call finishes there is no observed cost: the estimate stands in for
  // the calls in flight and for the next one, so the first wave reserves too.
  // It stays a floor afterwards; stopping a call early is the cap's safe side.
  const ledger = new SpendLedger(callEstimateUsd);
  for (const arm of opts.arms) opts.budget.observeItem(arm.id, callEstimateUsd);
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
    const byConstruction = arm.byConstruction ?? {};
    return {
      id: arm.id,
      label: arm.label,
      configuration: arm.configuration,
      byConstruction,
      completedRuns: runsScored.length,
      summary,
      thresholds: checkThresholds(summary, corpus.manifest.thresholds, byConstruction),
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
  // Each arm's claims the run bore out, computed once (#1932).
  const heldBy = new Map(
    report.arms.map((a) => [a, heldByConstruction(a.summary, a.byConstruction)]),
  );
  for (const a of report.arms) {
    const m = a.summary.metrics;
    const usd = a.cost.usdPerRequirement;
    // A metric the arm fixes by construction says nothing about it (#1900),
    // unless the run measured otherwise (#1920): then its value is printed,
    // marked ‡ in the cell itself (#1932).
    const held = heldBy.get(a)!;
    const fixed = (metric: keyof ByConstruction, value: string) => {
      if (held[metric] !== undefined) return "n/a†";
      return a.byConstruction[metric] === undefined ? value : `${value}‡`;
    };
    lines.push(
      `| ${a.id} | ${a.completedRuns} | ${ci(m.recall)} | ${ci(m.nonResemblingRecall)} | ${ci(m.precision)} | ` +
        `${fixed("citationAccuracy", ci(m.citationAccuracy))} | ${ci(m.citationCoverage)} | ${ci(m.verdictAccuracy)} | ` +
        `${fixed("hardErrors", String(a.summary.hardErrors))} | ${fixed("askRate", ci(m.askRate))} | ` +
        `${a.summary.cleanNegatives.join("/") || "n/a"} of ${a.summary.negatives} | ${a.failures} | ` +
        `${usd === null ? "unpriced" : `$${usd.toFixed(4)}`} | ` +
        `${Math.round(a.cost.inputTokensPerRequirement)} / ${Math.round(a.cost.completionTokensPerRequirement)} | ` +
        `${a.cost.secondsPerRequirement.toFixed(1)} |`,
    );
  }
  lines.push("");
  lines.push(
    "Hard errors: `compliant` on a pair whose truth is `gap` or `needs-ba-input`, summed over runs. " +
      "Clean negatives: negative requirements on which the arm ran and applied no rule, per run " +
      "(a failure is an error, never a clean negative).",
    "",
  );
  const fixedNotes = report.arms.flatMap((a) =>
    Object.entries(heldBy.get(a)!).map(([metric, why]) => `${a.id} ${metric}: ${why}`),
  );
  if (fixedNotes.length > 0) {
    lines.push(
      `† Fixed by construction, so it measures nothing and its bar is \`n/a\`: ${fixedNotes.join("; ")}.`,
      "",
    );
  }
  const brokenClaims = report.arms.flatMap((a) => {
    const held = heldBy.get(a)!;
    return Object.keys(a.byConstruction)
      .filter((metric) => !(metric in held))
      .map((metric) => `${a.id} ${metric}`);
  });
  if (brokenClaims.length > 0) {
    lines.push(
      `‡ Claimed fixed by construction, but measured otherwise, so it is judged: ${brokenClaims.join("; ")}.`,
      "",
    );
  }
  lines.push(
    `## Proposed pass thresholds (${report.thresholds.status}, ${report.thresholds.proposedIn})`,
    "",
  );
  lines.push("| Arm | Bar | Required | Measured | Pass |", "|---|---|---|---|---|");
  for (const a of report.arms) {
    for (const t of a.thresholds) {
      // A judged bar carries a note only when it broke a by-construction claim (#1932).
      const pass =
        t.pass === null ? "n/a†" : `${t.pass ? "yes" : "**no**"}${t.note === undefined ? "" : "‡"}`;
      lines.push(`| ${a.id} | ${t.bar} | ${t.required} | ${t.measured} | ${pass} |`);
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
