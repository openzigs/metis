/**
 * #2229 — runs every arm over every document `runs` times, judges each
 * reading, and assembles the report: requirement recall and precision, section
 * coverage, question precision, ambiguity recall and cost per document.
 *
 * Every model call goes through `meterProvider`, priced as METIS's usage
 * ledger prices it. An arm's spend and the judge's are metered apart, so the
 * cost per document is the reader's alone. The dollar cap (`EvalBudget`) is
 * checked before each reading, against the costliest reading of that arm so
 * far, and an unpriced call stops the run.
 */
import { LedgerCostMeter, meterProvider } from "../localization/cost.js";
import type { EvalBudget } from "../localization/runner.js";
import { TokenLedgerMeter } from "../governing/runner.js";
import type { AIProvider } from "../../ai/types.js";
import type { ArmOutput, DocArm } from "./arms.js";
import { documentKnowledge } from "./arms.js";
import type { DocUnderstandingItem } from "./corpus.js";
import { judgeReading, scoreReading, type DocScore, type Judgement } from "./scorer.js";

export const DEFAULT_DOC_RUNS = 1;
export const DEFAULT_DOC_BUDGET_USD = 10;
export const DEFAULT_SECTION_CONCURRENCY = 4;

export interface ReadingRecord {
  itemId: string;
  armId: string;
  run: number;
  output: Pick<ArmOutput, "requirements" | "questions"> | null;
  diagnostics: Record<string, number>;
  score: DocScore | null;
  judge: Pick<Judgement, "invalid" | "ungraded"> | null;
  /** Where the reading failed (the arm or the judge); absent on success. */
  error?: string;
  /** The arm's spend; null when a call was unpriced. */
  costUsd: number | null;
  judgeCostUsd: number | null;
  inputTokens: number;
  completionTokens: number;
  seconds: number;
}

export interface MetricSummary {
  mean: number | null;
  min: number | null;
  max: number | null;
  /** Readings with a value (a failed reading, or a ratio over zero, has none). */
  n: number;
}

export const SUMMARY_METRICS = [
  "requirementRecall",
  "requirementPrecision",
  "sectionCoverage",
  "questionPrecision",
  "ambiguityRecall",
  "quoteAccuracy",
] as const;
export type SummaryMetric = (typeof SUMMARY_METRICS)[number];

export interface ArmSummary {
  metrics: Record<SummaryMetric, MetricSummary>;
  extractedPerDocument: number | null;
  questionsPerDocument: number | null;
  /** The arm's mean spend per document; null when any reading was unpriced. */
  usdPerDocument: number | null;
  inputTokensPerDocument: number | null;
  completionTokensPerDocument: number | null;
  secondsPerDocument: number | null;
  failures: number;
  /** Readings attempted, failed ones included. */
  readings: number;
}

export interface DocArmReport {
  id: string;
  label: string;
  configuration: Record<string, string | number | boolean>;
  summary: ArmSummary;
  byItem: Array<{ itemId: string; summary: ArmSummary }>;
  records: ReadingRecord[];
}

export interface DocUnderstandingReport {
  model: string;
  judgeModel: string;
  runsRequested: number;
  budgetUsd: number;
  spentUsd: number;
  judgeSpentUsd: number;
  unpricedCalls: number;
  stopped: { reason: string; armId: string; itemId: string; run: number } | null;
  provenance: { commit: string | null; dirty: boolean | null };
  corpus: Array<{
    id: string;
    title: string;
    docxBytes: number;
    chars: number;
    sections: number;
    chunks: number;
    requirements: number;
    labelledSections: number;
    ambiguities: number;
  }>;
  arms: DocArmReport[];
}

export interface DocRunOptions {
  arms: DocArm[];
  runs: number;
  budget: EvalBudget;
  provider: AIProvider;
  sectionConcurrency?: number;
  provenance?: { commit: string | null; dirty: boolean | null };
  log?: (line: string) => void;
  now?: () => number;
}

function oneLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

/** Mean, min and max of the values present. */
export function summarise(values: ReadonlyArray<number | null | undefined>): MetricSummary {
  const xs = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (xs.length === 0) return { mean: null, min: null, max: null, n: 0 };
  return {
    mean: xs.reduce((a, b) => a + b, 0) / xs.length,
    min: Math.min(...xs),
    max: Math.max(...xs),
    n: xs.length,
  };
}

export function summariseRecords(records: readonly ReadingRecord[]): ArmSummary {
  const ok = records.filter((r) => r.error === undefined && r.score !== null);
  const metrics = Object.fromEntries(
    SUMMARY_METRICS.map((m) => [m, summarise(ok.map((r) => r.score![m]))]),
  ) as Record<SummaryMetric, MetricSummary>;
  const mean = (xs: number[]): number | null =>
    xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
  const priced = records.every((r) => r.costUsd !== null);
  return {
    metrics,
    extractedPerDocument: mean(ok.map((r) => r.score!.extracted)),
    questionsPerDocument: mean(ok.map((r) => r.score!.questions)),
    usdPerDocument: priced ? mean(records.map((r) => r.costUsd!)) : null,
    inputTokensPerDocument: mean(records.map((r) => r.inputTokens)),
    completionTokensPerDocument: mean(records.map((r) => r.completionTokens)),
    secondsPerDocument: mean(records.map((r) => r.seconds)),
    failures: records.length - ok.length,
    readings: records.length,
  };
}

/** Run every arm over every item `runs` times. Stops, and says why, at the first reading the cap refuses. */
export async function runDocUnderstandingEval(
  items: readonly DocUnderstandingItem[],
  opts: DocRunOptions,
): Promise<DocUnderstandingReport> {
  const now = opts.now ?? Date.now;
  const total = new LedgerCostMeter();
  const judgeTotal = new LedgerCostMeter();
  const records = new Map<string, ReadingRecord[]>(opts.arms.map((a) => [a.id, []]));
  const concurrency = Math.max(
    1,
    Math.floor(opts.sectionConcurrency ?? DEFAULT_SECTION_CONCURRENCY),
  );
  let stopped: DocUnderstandingReport["stopped"] = null;

  outer: for (let run = 1; run <= opts.runs; run++) {
    for (const item of items) {
      for (const arm of opts.arms) {
        const blocked = opts.budget.beforeItem(total, arm.id);
        if (blocked) {
          stopped = { reason: blocked, armId: arm.id, itemId: item.name, run };
          break outer;
        }
        const armMeter = new TokenLedgerMeter();
        const judgeMeter = new TokenLedgerMeter();
        const t0 = now();
        let output: ArmOutput | null = null;
        let judgement: Judgement | null = null;
        let error: string | undefined;
        try {
          output = await arm.read(item, {
            provider: meterProvider(meterProvider(opts.provider, total), armMeter),
            concurrency,
          });
        } catch (err) {
          error = `reader: ${oneLine(err)}`;
        }
        const seconds = (now() - t0) / 1000;
        if (output) {
          try {
            judgement = await judgeReading(
              meterProvider(
                meterProvider(meterProvider(opts.provider, total), judgeTotal),
                judgeMeter,
              ),
              item,
              output,
            );
          } catch (err) {
            error = `judge: ${oneLine(err)}`;
          }
        }
        if (error) opts.log?.(`[${arm.id}] ${item.name} run ${run} failed: ${error}`);
        const costUsd = armMeter.unpricedCalls() > 0 ? null : armMeter.spentUsd();
        const judgeCostUsd = judgeMeter.unpricedCalls() > 0 ? null : judgeMeter.spentUsd();
        if (costUsd !== null && judgeCostUsd !== null) {
          opts.budget.observeItem(arm.id, costUsd + judgeCostUsd);
        }
        const score = output && judgement ? scoreReading(item, output, judgement) : null;
        records.get(arm.id)!.push({
          itemId: item.name,
          armId: arm.id,
          run,
          output: output
            ? { requirements: output.requirements, questions: output.questions }
            : null,
          diagnostics: output?.diagnostics ?? {},
          score,
          judge: judgement ? { invalid: judgement.invalid, ungraded: judgement.ungraded } : null,
          ...(error !== undefined ? { error } : {}),
          costUsd,
          judgeCostUsd,
          inputTokens: armMeter.inputTokens(),
          completionTokens: armMeter.completionTokens(),
          seconds,
        });
        if (score) {
          opts.log?.(
            `[${arm.id}] ${item.name} run ${run}: recall=${score.requirementRecall.toFixed(2)} ` +
              `precision=${score.requirementPrecision?.toFixed(2) ?? "n/a"} ` +
              `coverage=${score.sectionCoverage.toFixed(2)} ` +
              `questions=${score.questions} worth=${score.questionPrecision?.toFixed(2) ?? "n/a"} ` +
              `ambiguities=${score.ambiguitiesRaised}/${score.ambiguities} ` +
              `$${costUsd?.toFixed(4) ?? "unpriced"} (judge $${judgeCostUsd?.toFixed(4) ?? "unpriced"})`,
          );
        }
      }
    }
  }

  return {
    model: `${opts.provider.key}/${opts.provider.model}`,
    judgeModel: `${opts.provider.key}/${opts.provider.model}`,
    runsRequested: opts.runs,
    budgetUsd: opts.budget.budgetUsd,
    spentUsd: total.spentUsd(),
    judgeSpentUsd: judgeTotal.spentUsd(),
    unpricedCalls: total.unpricedCalls(),
    stopped,
    provenance: opts.provenance ?? { commit: null, dirty: null },
    corpus: items.map((item) => ({
      id: item.name,
      title: item.title,
      docxBytes: item.docxBytes,
      chars: item.text.length,
      sections: item.sections.length,
      chunks: documentKnowledge(item).chunks,
      requirements: item.labels.requirements.length,
      labelledSections: new Set(item.labels.requirements.map((r) => r.section)).size,
      ambiguities: item.labels.ambiguities.length,
    })),
    arms: opts.arms.map((arm) => {
      const recs = records.get(arm.id)!;
      return {
        id: arm.id,
        label: arm.label,
        configuration: arm.configuration,
        summary: summariseRecords(recs),
        byItem: items.map((item) => ({
          itemId: item.name,
          summary: summariseRecords(recs.filter((r) => r.itemId === item.name)),
        })),
        records: recs,
      };
    }),
  };
}

/**
 * One report from several invocations over the same model and commit (no
 * model is called): each invocation reads part of the corpus, so a reading
 * that takes longer than one sitting is still one reading. Records are
 * pooled per arm and every summary is recomputed from them.
 */
export function combineReports(reports: readonly DocUnderstandingReport[]): DocUnderstandingReport {
  if (reports.length === 0) throw new Error("nothing to combine");
  const first = reports[0]!;
  for (const r of reports) {
    if (r.model !== first.model) {
      throw new Error(`cannot combine readings of ${first.model} and ${r.model}`);
    }
    if (r.provenance.commit !== first.provenance.commit) {
      throw new Error(
        `cannot combine readings at ${first.provenance.commit ?? "an unknown commit"} and ${r.provenance.commit ?? "an unknown commit"}`,
      );
    }
  }
  const corpus = new Map<string, DocUnderstandingReport["corpus"][number]>();
  for (const r of reports) for (const c of r.corpus) if (!corpus.has(c.id)) corpus.set(c.id, c);
  const arms = new Map<string, Omit<DocArmReport, "summary" | "byItem">>();
  for (const r of reports) {
    for (const a of r.arms) {
      const held = arms.get(a.id);
      if (held) held.records.push(...a.records);
      else
        arms.set(a.id, {
          id: a.id,
          label: a.label,
          configuration: a.configuration,
          records: [...a.records],
        });
    }
  }
  const items = [...corpus.keys()];
  // Every call belongs to a reading's reader or its judge, so the spend is the
  // records' own: it stays right when a caller has dropped arms from a report.
  const records = [...arms.values()].flatMap((a) => a.records);
  const judgeSpentUsd = records.reduce((s, r) => s + (r.judgeCostUsd ?? 0), 0);
  return {
    model: first.model,
    judgeModel: first.judgeModel,
    runsRequested: Math.max(...reports.map((r) => r.runsRequested)),
    budgetUsd: reports.reduce((s, r) => s + r.budgetUsd, 0),
    spentUsd: records.reduce((s, r) => s + (r.costUsd ?? 0), 0) + judgeSpentUsd,
    judgeSpentUsd,
    unpricedCalls: reports.reduce((s, r) => s + r.unpricedCalls, 0),
    stopped: reports.find((r) => r.stopped)?.stopped ?? null,
    provenance: {
      commit: first.provenance.commit,
      dirty: reports.some((r) => r.provenance.dirty === null)
        ? null
        : reports.some((r) => r.provenance.dirty),
    },
    corpus: [...corpus.values()],
    arms: [...arms.values()].map((a) => ({
      ...a,
      summary: summariseRecords(a.records),
      byItem: items.map((itemId) => ({
        itemId,
        summary: summariseRecords(a.records.filter((r) => r.itemId === itemId)),
      })),
    })),
  };
}

// ── Rendering ────────────────────────────────────────────────────────────────

const pct = (m: MetricSummary): string =>
  m.mean === null
    ? "n/a"
    : m.n > 1 && m.min !== m.max
      ? `${m.mean.toFixed(2)} [${m.min!.toFixed(2)}–${m.max!.toFixed(2)}]`
      : m.mean.toFixed(2);
const usd = (v: number | null): string => (v === null ? "unpriced" : `$${v.toFixed(4)}`);
const num = (v: number | null, digits = 1): string => (v === null ? "n/a" : v.toFixed(digits));

function metricRow(label: string, s: ArmSummary): string {
  if (s.readings === 0) return `| ${label} | not run |${" |".repeat(11)}`;
  const m = s.metrics;
  return (
    `| ${label} | ${pct(m.requirementRecall)} | ${pct(m.requirementPrecision)} | ${pct(m.sectionCoverage)} | ` +
    `${pct(m.questionPrecision)} | ${pct(m.ambiguityRecall)} | ${pct(m.quoteAccuracy)} | ` +
    `${num(s.extractedPerDocument)} | ${num(s.questionsPerDocument)} | ${usd(s.usdPerDocument)} | ` +
    `${num(s.inputTokensPerDocument, 0)} / ${num(s.completionTokensPerDocument, 0)} | ${num(s.secondsPerDocument)} | ${s.failures} |`
  );
}

const METRIC_HEADER =
  "| Arm | Requirement recall | Requirement precision | Section coverage | Question precision | Ambiguity recall | Quote accuracy | Requirements / doc | Questions / doc | $ / doc | Tokens in / out per doc | s / doc | Failures |\n" +
  "|---|---|---|---|---|---|---|---|---|---|---|---|---|";

export function toMarkdownReport(report: DocUnderstandingReport): string {
  const lines: string[] = [];
  lines.push(`# Document understanding eval (#2229)`);
  lines.push("");
  lines.push(
    `Model: **${report.model}** · Judge: **${report.judgeModel}** · Runs requested: **${report.runsRequested}** · ` +
      `Budget: **$${report.budgetUsd}** · Spent: **$${report.spentUsd.toFixed(4)}** (judge $${report.judgeSpentUsd.toFixed(4)})` +
      (report.unpricedCalls > 0 ? ` · Unpriced calls: **${report.unpricedCalls}**` : ""),
  );
  lines.push("");
  lines.push(
    `Commit: ${report.provenance.commit ?? "unknown"}${report.provenance.dirty ? " (uncommitted changes)" : ""}`,
  );
  if (report.stopped) {
    lines.push("");
    lines.push(
      `**Stopped early** before ${report.stopped.armId} on ${report.stopped.itemId}, run ${report.stopped.run}: ${report.stopped.reason}`,
    );
  }
  lines.push("");
  lines.push("## Results (mean over documents and runs; [min–max] where they differ)");
  lines.push("");
  lines.push(METRIC_HEADER);
  for (const a of report.arms) lines.push(metricRow(a.id, a.summary));
  lines.push("");
  lines.push(
    "Requirement recall and precision, section coverage and ambiguity recall are computed in code from the judge's matching of each extracted requirement to a labelled one and each question to a labelled ambiguity. Question precision is the judge's verdict of \"worth asking\". Quote accuracy is deterministic: requirement quotes found verbatim (whitespace aside) in the converted document; arm A gives no quotes. The cost per document is the reader's alone; the judge's spend is reported apart.",
  );
  lines.push("");
  lines.push("## By document");
  for (const doc of report.corpus) {
    lines.push("");
    lines.push(`### ${doc.id} — ${doc.title}`);
    lines.push("");
    lines.push(
      `${doc.chars} characters converted from ${doc.docxBytes} bytes of Word; ${doc.sections} sections, ${doc.chunks} chunks; ` +
        `${doc.requirements} labelled requirements in ${doc.labelledSections} sections, ${doc.ambiguities} labelled ambiguities.`,
    );
    lines.push("");
    lines.push(METRIC_HEADER);
    for (const a of report.arms) {
      const s = a.byItem.find((b) => b.itemId === doc.id)!.summary;
      lines.push(metricRow(a.id, s));
    }
    for (const a of report.arms) {
      const recs = a.records.filter((r) => r.itemId === doc.id);
      for (const r of recs) {
        const d = r.diagnostics;
        const extra =
          d.retrievedChars !== undefined
            ? ` Read ${d.retrievedChars} of ${d.documentChars} characters (${d.retrievedChunks} of ${d.documentChunks} chunks); the agent extracted ${d.agentRequirements} requirements and ${d.agentFindings} findings.`
            : "";
        if (r.error) {
          lines.push("");
          lines.push(`- ${a.id} run ${r.run}: **failed** — ${r.error}`);
        } else if (r.score) {
          lines.push("");
          lines.push(
            `- ${a.id} run ${r.run}: missed requirements ${r.score.missedRequirements.join(", ") || "none"}; ` +
              `missed sections ${r.score.missedSections.length}; ambiguities not raised ${r.score.missedAmbiguities.join(", ") || "none"}; ` +
              `repeats ${r.score.repeats}; judge invalid ${r.judge?.invalid ?? 0}, ungraded ${r.judge?.ungraded ?? 0}.${extra}`,
          );
        }
      }
    }
  }
  lines.push("");
  lines.push("## Arms");
  for (const a of report.arms) {
    lines.push("");
    lines.push(`### ${a.label}`);
    lines.push("");
    lines.push("| Setting | Value |");
    lines.push("|---|---|");
    for (const [k, v] of Object.entries(a.configuration)) lines.push(`| ${k} | ${String(v)} |`);
  }
  lines.push("");
  return lines.join("\n");
}

export function toJsonReport(
  report: DocUnderstandingReport,
  meta: { generatedAt: string },
): string {
  return `${JSON.stringify({ ...meta, ...report }, null, 2)}\n`;
}
