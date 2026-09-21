/**
 * Epic #1107 / Issue #1108 — `eval:verification` runner, thresholds and reports.
 *
 * Runs one or more {@link VerifierArm}s over the SAME labelled corpus and reports
 * **precision, recall and cost separately** — never blended. #1108 is explicit
 * about why: METIS is recall-first, so a single score would let a recall
 * regression hide behind a precision gain, and the cost half of the trade is the
 * entire reason the epic gates A1 on a measurement rather than on intuition.
 *
 * Conventions are lifted from `eval:impact-recall` (#930/#1016) rather than
 * invented: repeated runs with the spread reported, thresholds checked against
 * the MEAN, and floors resolved per CONFIGURATION (here, per ARM) so numbers from
 * one arm can never be gated against another arm's floors.
 *
 * ── THE DECISION THIS HARNESS EXISTS TO INFORM ──────────────────────────────
 *
 * {@link compareArms} answers "is the panel better than free?" and deliberately
 * stops short of answering "is it worth it". The pass rule is recall-first —
 * recall must not regress, and something must improve — and the token and
 * wall-clock cost is reported beside it, unweighted. Encoding a token budget here
 * would bury a product decision in a threshold constant. #931 (an LLM that
 * regressed precision as a seeder) and #936 (the same model that improved it as a
 * filter) are why the comparison is structural rather than assumed.
 */
import type { VerificationCase, VerificationCorpus } from "./corpus.js";
import { provenanceMix } from "./corpus.js";
import {
  aggregateByHardCase,
  aggregateCaseScores,
  aggregateFaithfulness,
  scoreCase,
  type CaseScore,
  type VerificationAggregate,
} from "./scorer.js";
import type { FaithfulnessAggregate } from "../../grounding/faithfulness-metric.js";
import type { ArmUsage, VerifierArm, VerifierArmId } from "./arms.js";

// ── Cost accounting (#1108: tokens AND wall-clock, reported separately) ──────

/** The cost of running ONE arm across the whole corpus once. */
export interface ArmRunCost {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Model round-trips. Zero for the deterministic arm — the point of the baseline. */
  llmCalls: number;
  /** End-to-end wall clock for the arm's pass over the corpus. */
  wallClockMs: number;
  /**
   * Tokens ÷ findings — the unit an A1 default-on decision is actually made in,
   * since a production run verifies ~135 findings, not 12.
   */
  tokensPerFinding: number;
}

function emptyUsage(): ArmUsage {
  return { promptTokens: 0, completionTokens: 0, llmCalls: 0 };
}

function addUsage(into: ArmUsage, u: ArmUsage | undefined): ArmUsage {
  if (!u) return into;
  return {
    promptTokens: into.promptTokens + (u.promptTokens || 0),
    completionTokens: into.completionTokens + (u.completionTokens || 0),
    llmCalls: into.llmCalls + (u.llmCalls || 0),
  };
}

// ── Running an arm ──────────────────────────────────────────────────────────

/** One arm's pass over the corpus. */
export interface ArmRunResult {
  armId: VerifierArmId;
  armLabel: string;
  usesLlm: boolean;
  scores: CaseScore[];
  aggregate: VerificationAggregate;
  /** Per-hard-case breakdown, so the four #1108 cases are inspectable in aggregate. */
  byHardCase: Record<string, VerificationAggregate & { kind: string }>;
  cost: ArmRunCost;
  /**
   * Epic #1316 (#1318) — the SHARED claim-level faithfulness metric for this
   * arm, or `null` when the arm does not compute it (the deterministic baseline
   * always; the panel arm unless `--faithfulness` was passed).
   *
   * A SIBLING of `aggregate`, never folded into it. Faithfulness answers a
   * different question from precision/recall — "does the retrieved text back the
   * claim?" rather than "would a reader be warned?" — and #1108's rule that two
   * axes are never blended applies to a third just as hard.
   */
  faithfulness: FaithfulnessAggregate | null;
}

/**
 * Run one arm over every case, sequentially. Sequential on purpose: an LLM arm
 * must not fan out concurrent provider calls, and wall-clock is a REPORTED metric
 * — parallelising it would make the number meaningless as a cost signal.
 */
export async function runArm(
  corpus: VerificationCorpus,
  arm: VerifierArm,
  now: () => number = () => Date.now(),
): Promise<ArmRunResult> {
  const started = now();
  const scores: CaseScore[] = [];
  let usage = emptyUsage();
  for (const c of corpus.cases) {
    const verdict = await arm.verify(c);
    usage = addUsage(usage, verdict.usage);
    scores.push(scoreCase(c, verdict.status, verdict.faithfulness));
  }
  const wallClockMs = now() - started;
  const totalTokens = usage.promptTokens + usage.completionTokens;
  return {
    armId: arm.id,
    armLabel: arm.label,
    usesLlm: arm.usesLlm,
    scores,
    aggregate: aggregateCaseScores(scores),
    byHardCase: aggregateByHardCase(scores),
    cost: {
      ...usage,
      totalTokens,
      wallClockMs,
      tokensPerFinding: corpus.cases.length === 0 ? 0 : totalTokens / corpus.cases.length,
    },
    faithfulness: aggregateFaithfulness(scores),
  };
}

// ── Repeated runs (mirrors #1016: gate on the mean, report the spread) ───────

/** Per-metric spread across repeated runs. */
export interface MetricSpread {
  values: number[];
  mean: number;
  min: number;
  max: number;
}

function spreadOf(values: number[]): MetricSpread {
  return {
    values,
    mean: values.reduce((a, b) => a + b, 0) / values.length,
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

/** N repeated runs of ONE arm, folded. */
export interface ArmRunSummary {
  armId: VerifierArmId;
  armLabel: string;
  usesLlm: boolean;
  runCount: number;
  /** Every run in order. `runs[0]` supplies the per-case detail in reports. */
  runs: ArmRunResult[];
  /** Thresholds are checked against THIS, not against a single sample. */
  meanAggregate: VerificationAggregate;
  meanCost: ArmRunCost;
  spreads: { recall: MetricSpread; precision: MetricSpread; totalTokens: MetricSpread };
  /**
   * Epic #1316 (#1318) — faithfulness pooled across ALL runs, or `null` when the
   * arm does not compute it.
   *
   * Pooled rather than averaged over per-run means on purpose: with unverifiable
   * cases excluded, each run's denominator can differ, and a mean of means would
   * silently weight a run that scored 2 cases the same as one that scored 12.
   */
  meanFaithfulness: FaithfulnessAggregate | null;
}

function meanOf(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Fold N runs of one arm into mean aggregate + mean cost + spreads. Pure. */
export function summarizeArmRuns(runs: ArmRunResult[]): ArmRunSummary {
  if (runs.length === 0) throw new Error("summarizeArmRuns requires at least one run");
  const pick = (f: (a: VerificationAggregate) => number): number =>
    meanOf(runs.map((r) => f(r.aggregate)));
  const cost = (f: (c: ArmRunCost) => number): number => meanOf(runs.map((r) => f(r.cost)));
  return {
    armId: runs[0].armId,
    armLabel: runs[0].armLabel,
    usesLlm: runs[0].usesLlm,
    runCount: runs.length,
    runs,
    meanAggregate: {
      caseCount: runs[0].aggregate.caseCount,
      truePositives: pick((a) => a.truePositives),
      falsePositives: pick((a) => a.falsePositives),
      falseNegatives: pick((a) => a.falseNegatives),
      trueNegatives: pick((a) => a.trueNegatives),
      recall: pick((a) => a.recall),
      precision: pick((a) => a.precision),
      overFlagRate: pick((a) => a.overFlagRate),
      abstentionRate: pick((a) => a.abstentionRate),
    },
    meanCost: {
      promptTokens: cost((c) => c.promptTokens),
      completionTokens: cost((c) => c.completionTokens),
      totalTokens: cost((c) => c.totalTokens),
      llmCalls: cost((c) => c.llmCalls),
      wallClockMs: cost((c) => c.wallClockMs),
      tokensPerFinding: cost((c) => c.tokensPerFinding),
    },
    spreads: {
      recall: spreadOf(runs.map((r) => r.aggregate.recall)),
      precision: spreadOf(runs.map((r) => r.aggregate.precision)),
      totalTokens: spreadOf(runs.map((r) => r.cost.totalTokens)),
    },
    meanFaithfulness: aggregateFaithfulness(runs.flatMap((r) => r.scores)),
  };
}

/** Run one arm `runCount` times and summarize. Sequential (see {@link runArm}). */
export async function runArmRepeated(
  corpus: VerificationCorpus,
  arm: VerifierArm,
  runCount = 1,
  now?: () => number,
): Promise<ArmRunSummary> {
  const n = Math.max(1, Math.floor(runCount));
  const runs: ArmRunResult[] = [];
  for (let i = 0; i < n; i += 1) runs.push(await runArm(corpus, arm, now));
  return summarizeArmRuns(runs);
}

/**
 * Parse `--runs <n>`. Defaults to 3 when ANY selected arm makes live model calls
 * (one sample cannot gate a non-deterministic pipeline — #1016) and 1 when every
 * arm is deterministic, where repeats are byte-identical.
 */
export function parseRunCount(argv: string[], anyArmUsesLlm: boolean): number {
  const i = argv.indexOf("--runs");
  const raw = i >= 0 ? Number(argv[i + 1]) : NaN;
  if (Number.isFinite(raw) && raw >= 1) return Math.floor(raw);
  return anyArmUsesLlm ? 3 : 1;
}

// ── Per-arm regression floors ───────────────────────────────────────────────

/**
 * Regression guards for ONE arm. `recall`/`precision` are FLOORS;
 * `maxOverFlagRate` is a CEILING. There is deliberately no cost threshold: cost
 * is reported, not gated, because "how many tokens is a point of recall worth"
 * is a product decision and burying it in a constant here would make it invisible.
 */
export interface VerificationThresholds {
  recall: number;
  precision: number;
  maxOverFlagRate: number;
}

/**
 * MEASURED BASELINE for the deterministic arm on `verification-01-finding-verdicts`
 * (12 cases, offline, 2026-07-28):
 *
 *   recall        0.3333   (TP 2, FN 4)
 *   precision     0.5000   (TP 2, FP 2)
 *   overFlagRate  0.3333   (FP 2 of 6 supported cases)
 *   cost          0 tokens, 0 model calls
 *
 * Read against the corpus caveat: half the cases are deliberately hard, so 0.33
 * is NOT "the deterministic gate catches a third of production's bad findings".
 * What it does say, and this is the load-bearing result for #1109, is WHERE the
 * free gate's recall goes: every one of the four misses (VC-01, VC-03, VC-08,
 * VC-10) requires READING the retrieved evidence, which the gate structurally
 * cannot do. Its two catches (VC-05, VC-06) are the provenance and
 * absence-health checks it was built for, and it gets those for free. The two
 * over-flags (VC-11, VC-12) price two known design choices: rule (3) firing on a
 * finding backed by a retrieved DOCUMENT, and the "deliberately generous"
 * absence classifier matching a subordinate clause.
 *
 * The arm is deterministic, so repeats are byte-identical and there is no noise
 * to absorb; the floors nonetheless sit one case below the measured values so a
 * corpus edit does not fail the gate before anyone has re-measured. A genuine
 * regression — the gate stopping its detection of hallucinated citations — still
 * trips them.
 */
export const DETERMINISTIC_ARM_THRESHOLDS: VerificationThresholds = {
  recall: 0.16, // one TP lost (2→1) ⇒ 0.1667; two lost fails
  precision: 0.33, // one FP added (2→3) ⇒ 0.40; two added fails
  maxOverFlagRate: 0.5, // one over-flag of headroom (2→3 of 6 ⇒ 0.50)
};

/**
 * Floors for the #1109 panel arm are NOT set here, and that is deliberate. The
 * panel's bar is not an absolute number — it is {@link compareArms} against the
 * baseline measured in the same process, on the same corpus, in the same run.
 * Registering a guessed floor before the arm exists would let it "pass" without
 * ever beating free.
 */
const THRESHOLDS_BY_ARM: Partial<Record<VerifierArmId, VerificationThresholds>> = {
  deterministic: DETERMINISTIC_ARM_THRESHOLDS,
};

/** Resolve floors for an arm, or `null` when the arm has no registered floors. */
export function thresholdsForArm(armId: VerifierArmId): VerificationThresholds | null {
  return THRESHOLDS_BY_ARM[armId] ?? null;
}

export interface ThresholdCheck {
  metric: "recall" | "precision" | "overFlagRate";
  direction: "floor" | "ceiling";
  bound: number;
  value: number;
  passed: boolean;
}

/** Compare an aggregate against an arm's floors/ceilings. Pure. */
export function checkThresholds(
  aggregate: VerificationAggregate,
  thresholds: VerificationThresholds,
): { passed: boolean; checks: ThresholdCheck[] } {
  const checks: ThresholdCheck[] = [
    {
      metric: "recall",
      direction: "floor",
      bound: thresholds.recall,
      value: aggregate.recall,
      passed: aggregate.recall >= thresholds.recall,
    },
    {
      metric: "precision",
      direction: "floor",
      bound: thresholds.precision,
      value: aggregate.precision,
      passed: aggregate.precision >= thresholds.precision,
    },
    {
      metric: "overFlagRate",
      direction: "ceiling",
      bound: thresholds.maxOverFlagRate,
      value: aggregate.overFlagRate,
      passed: aggregate.overFlagRate <= thresholds.maxOverFlagRate,
    },
  ];
  return { passed: checks.every((c) => c.passed), checks };
}

// ── Arm comparison — the A1 default-on question ─────────────────────────────

/** Baseline-vs-candidate, with cost reported but NOT folded into the verdict. */
export interface ArmComparison {
  baselineArm: VerifierArmId;
  candidateArm: VerifierArmId;
  recallDelta: number;
  precisionDelta: number;
  overFlagRateDelta: number;
  /** Extra tokens the candidate spends per finding. Reported, never gated. */
  tokensPerFindingDelta: number;
  /** Extra wall clock over the whole corpus. Reported, never gated. */
  wallClockMsDelta: number;
  /** Did the candidate clear the recall-first bar? */
  beatsBaseline: boolean;
  /** Human-readable justification for {@link beatsBaseline}, one line per rule. */
  reasons: string[];
}

/**
 * Compare a candidate arm against the baseline. RECALL-FIRST: the candidate must
 * not regress recall (a lost warning is invisible to the user), and must improve
 * at least one of recall or precision. Cost is reported alongside and never
 * folded in — see the module doc.
 */
export function compareArms(baseline: ArmRunSummary, candidate: ArmRunSummary): ArmComparison {
  const b = baseline.meanAggregate;
  const c = candidate.meanAggregate;
  const recallDelta = c.recall - b.recall;
  const precisionDelta = c.precision - b.precision;
  const reasons: string[] = [];
  const recallHeld = recallDelta >= 0;
  const improved = recallDelta > 0 || precisionDelta > 0;
  reasons.push(
    recallHeld
      ? `recall held or improved (${b.recall.toFixed(4)} → ${c.recall.toFixed(4)})`
      : `RECALL REGRESSED (${b.recall.toFixed(4)} → ${c.recall.toFixed(4)}) — disqualifying in a recall-first system`,
  );
  reasons.push(
    improved
      ? `improved at least one axis (recall ${recallDelta >= 0 ? "+" : ""}${recallDelta.toFixed(4)}, precision ${precisionDelta >= 0 ? "+" : ""}${precisionDelta.toFixed(4)})`
      : "improved NEITHER recall nor precision — the candidate is paying tokens for nothing",
  );
  reasons.push(
    `cost delta ${(candidate.meanCost.tokensPerFinding - baseline.meanCost.tokensPerFinding).toFixed(1)} tokens/finding, ` +
      `${(candidate.meanCost.wallClockMs - baseline.meanCost.wallClockMs).toFixed(0)}ms/corpus — REPORTED, not gated: ` +
      "whether that price is worth the quality delta is a product decision, not a threshold constant.",
  );
  return {
    baselineArm: baseline.armId,
    candidateArm: candidate.armId,
    recallDelta,
    precisionDelta,
    overFlagRateDelta: c.overFlagRate - b.overFlagRate,
    tokensPerFindingDelta: candidate.meanCost.tokensPerFinding - baseline.meanCost.tokensPerFinding,
    wallClockMsDelta: candidate.meanCost.wallClockMs - baseline.meanCost.wallClockMs,
    beatsBaseline: recallHeld && improved,
    reasons,
  };
}

// ── Reporting ───────────────────────────────────────────────────────────────

/** One arm's threshold outcome, or `null` when the arm has no registered floors. */
export interface ArmGateResult {
  summary: ArmRunSummary;
  thresholds: VerificationThresholds | null;
  checks: ThresholdCheck[];
  /** Vacuously true when no floors are registered (the panel, pre-#1109 tuning). */
  passed: boolean;
}

/** Apply an arm's registered floors to its mean aggregate. */
export function gateArm(summary: ArmRunSummary): ArmGateResult {
  const thresholds = thresholdsForArm(summary.armId);
  if (!thresholds) return { summary, thresholds: null, checks: [], passed: true };
  const { passed, checks } = checkThresholds(summary.meanAggregate, thresholds);
  return { summary, thresholds, checks, passed };
}

/** Everything one `eval:verification` invocation produced. */
export interface VerificationEvalReport {
  corpus: VerificationCorpus;
  arms: ArmGateResult[];
  /** Present only when both the baseline and a candidate arm ran. */
  comparison: ArmComparison | null;
  passed: boolean;
}

/** Assemble the report: gate each arm, then compare candidates to the baseline. */
export function buildReport(
  corpus: VerificationCorpus,
  summaries: ArmRunSummary[],
): VerificationEvalReport {
  const arms = summaries.map(gateArm);
  const baseline = summaries.find((s) => s.armId === "deterministic");
  const candidate = summaries.find((s) => s.armId !== "deterministic");
  const comparison = baseline && candidate ? compareArms(baseline, candidate) : null;
  return { corpus, arms, comparison, passed: arms.every((a) => a.passed) };
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

/**
 * Epic #1316 (#1318) — render an arm's faithfulness, keeping THREE facts apart
 * that a single number would collapse:
 *
 *   `n/a`             this arm does not compute the metric (the free baseline
 *                     structurally cannot — it never reads the evidence text);
 *   `unverifiable`    it computed the metric and nothing was verifiable;
 *   `0.8750 (7 scored, 2 unverifiable)`
 *                     a real mean, with how much of the corpus produced it.
 *
 * Rendering the first two as `0` would read as "faithfulness is terrible here",
 * which is precisely the vacuous-truth failure #1317 removed from the stub judge,
 * pointed the other way.
 */
function renderFaithfulness(f: FaithfulnessAggregate | null): string {
  if (!f) return "n/a — arm does not compute it";
  if (f.mean === null) return `unverifiable (0 scored, ${f.unverifiable} unverifiable)`;
  return `${f.mean.toFixed(4)} (${f.scored} scored, ${f.unverifiable} unverifiable)`;
}

/** Machine-readable report written to `eval-results/`. */
export function toJsonReport(report: VerificationEvalReport): Record<string, unknown> {
  const mix = provenanceMix(report.corpus);
  return {
    kind: "finding-verification",
    corpus: report.corpus.id,
    caseCount: report.corpus.cases.length,
    // Reproduced in every artifact: a number lifted out of this file without its
    // caveat is a number that will be misread as a production estimate.
    corpusWarning: report.corpus.warning,
    provenance: { ...mix, note: report.corpus.provenanceNote },
    passed: report.passed,
    arms: report.arms.map((a) => ({
      arm: a.summary.armId,
      label: a.summary.armLabel,
      usesLlm: a.summary.usesLlm,
      runCount: a.summary.runCount,
      passed: a.passed,
      thresholds: a.checks,
      // Quality and cost are SIBLING keys, never combined — #1108.
      quality: a.summary.meanAggregate,
      cost: a.summary.meanCost,
      spreads: a.summary.spreads,
      byHardCase: a.summary.runs[0].byHardCase,
      // Epic #1316 (#1318) — the shared claim-level metric, a SIBLING of
      // `quality` and `cost`, never folded into either. `null` means this arm
      // does not compute it; `mean: null` means it computed and nothing was
      // verifiable. Two different facts, two different shapes.
      faithfulness: a.summary.meanFaithfulness,
      cases: a.summary.runs[0].scores,
    })),
    comparison: report.comparison,
    commit: process.env.GITHUB_SHA ?? process.env.GIT_COMMIT ?? null,
  };
}

/** Human-readable Markdown so before/after runs diff cleanly. */
export function toMarkdownReport(report: VerificationEvalReport): string {
  const mix = provenanceMix(report.corpus);
  const lines: string[] = [];
  lines.push(`# Finding-verification eval — \`${report.corpus.id}\``);
  lines.push("");
  lines.push(
    `Cases: **${report.corpus.cases.length}** (${mix.real} real, ${mix.synthesised} synthesised) · ` +
      `Result: **${report.passed ? "PASS" : "FAIL"}**`,
  );
  lines.push("");
  lines.push(`> ⚠️ ${report.corpus.warning}`);
  lines.push("");

  lines.push("## Quality — precision and recall, reported separately");
  lines.push("");
  lines.push(
    "| Arm | Runs | Recall | Precision | Over-flag rate | Abstained | TP | FP | FN | TN |",
  );
  lines.push(
    "|-----|------|--------|-----------|----------------|-----------|----|----|----|----|",
  );
  for (const a of report.arms) {
    const q = a.summary.meanAggregate;
    lines.push(
      `| ${a.summary.armId} | ${a.summary.runCount} | ${pct(q.recall)} | ${pct(q.precision)} | ` +
        `${pct(q.overFlagRate)} | ${pct(q.abstentionRate)} | ${q.truePositives} | ${q.falsePositives} | ` +
        `${q.falseNegatives} | ${q.trueNegatives} |`,
    );
  }
  lines.push("");
  lines.push(
    "> No blended score is reported. In a recall-first system an F1 lets a recall regression hide " +
      "behind a precision gain, and over-flagging is the failure mode that erodes reviewer trust " +
      "fastest — so it gets its own column.",
  );
  lines.push("");

  lines.push("## Faithfulness — the one claim-level metric, shared with docs-gen (#1318)");
  lines.push("");
  lines.push("| Arm | Mean faithfulness | Claims supported / total |");
  lines.push("|-----|-------------------|--------------------------|");
  for (const a of report.arms) {
    const f = a.summary.meanFaithfulness;
    const claims = f && f.mean !== null ? `${f.supportedClaims} / ${f.totalClaims}` : "—";
    lines.push(`| ${a.summary.armId} | ${renderFaithfulness(f)} | ${claims} |`);
  }
  lines.push("");
  lines.push(
    "> The SAME metric `docs-gen` reports for a synthesised section: decompose the text into " +
      "atomic claims, then ask whether each is entailed by the retrieved evidence. Unverifiable " +
      "cases are EXCLUDED from the mean rather than counted as passes — a metric that scored 1.0 " +
      "whenever the judge was unavailable would report the product healthiest exactly when it " +
      "knew least. An arm that cannot compute it reads `n/a`, never `0`: the deterministic gate " +
      "is not bad at faithfulness, it is structurally unable to be asked.",
  );
  lines.push("");

  lines.push("## Cost — reported beside quality, never folded into it");
  lines.push("");
  lines.push(
    "| Arm | LLM? | Model calls | Prompt tok | Completion tok | Tokens/finding | Wall clock |",
  );
  lines.push(
    "|-----|------|-------------|------------|----------------|----------------|------------|",
  );
  for (const a of report.arms) {
    const c = a.summary.meanCost;
    lines.push(
      `| ${a.summary.armId} | ${a.summary.usesLlm ? "yes" : "no"} | ${c.llmCalls.toFixed(0)} | ` +
        `${c.promptTokens.toFixed(0)} | ${c.completionTokens.toFixed(0)} | ${c.tokensPerFinding.toFixed(1)} | ` +
        `${c.wallClockMs.toFixed(0)}ms |`,
    );
  }
  lines.push("");

  if (report.comparison) {
    const cmp = report.comparison;
    lines.push(`## Is \`${cmp.candidateArm}\` better than free?`);
    lines.push("");
    lines.push(
      `**${cmp.beatsBaseline ? "BEATS" : "DOES NOT BEAT"} the deterministic baseline.** ` +
        `Recall ${cmp.recallDelta >= 0 ? "+" : ""}${cmp.recallDelta.toFixed(4)} · ` +
        `precision ${cmp.precisionDelta >= 0 ? "+" : ""}${cmp.precisionDelta.toFixed(4)} · ` +
        `over-flag ${cmp.overFlagRateDelta >= 0 ? "+" : ""}${cmp.overFlagRateDelta.toFixed(4)} · ` +
        `${cmp.tokensPerFindingDelta.toFixed(1)} tokens/finding.`,
    );
    lines.push("");
    for (const r of cmp.reasons) lines.push(`- ${r}`);
    lines.push("");
  } else {
    lines.push("## Is the panel better than free?");
    lines.push("");
    lines.push(
      "> **Unanswered — the multi-lens panel arm does not exist yet (#1109).** This run reports the " +
        "BASELINE arm only. Wiring the panel is a one-function change: implement a `PanelArmFactory` " +
        "and pass it to the runner; corpus, scoring, cost accounting, thresholds and this comparison " +
        "are already arm-agnostic. Until then the A1 default-on decision has a yardstick but no " +
        "candidate to measure against it.",
    );
    lines.push("");
  }

  for (const a of report.arms) {
    lines.push(`## Per-case — \`${a.summary.armId}\``);
    lines.push("");
    const showsFaithfulness = a.summary.meanFaithfulness !== null;
    lines.push(
      `| Case | Hard case | Origin | Expected | Verdict | Outcome |${showsFaithfulness ? " Faithfulness |" : ""}`,
    );
    lines.push(
      `|------|-----------|--------|----------|---------|---------|${showsFaithfulness ? "--------------|" : ""}`,
    );
    const byId = new Map(report.corpus.cases.map((c) => [c.id, c]));
    for (const s of a.summary.runs[0].scores) {
      const origin = byId.get(s.id)?.provenance.origin ?? "?";
      // #1318 — per case: a number, or `unverifiable` with the reason the judge
      // gave. A blank cell would be indistinguishable from a zero.
      const f = s.faithfulness;
      const cell =
        f && f.score !== null
          ? `${f.score.toFixed(4)} (${f.supportedClaims}/${f.totalClaims})`
          : `unverifiable (${f?.unverifiableReason ?? "no-evidence"})`;
      lines.push(
        `| ${s.id} | ${s.hardCase} | ${origin} | ${s.expectedSupported ? "supported" : "UNSUPPORTED"} | ` +
          `${s.status ?? "null (no signal)"} | ${s.outcome} |${showsFaithfulness ? ` ${cell} |` : ""}`,
      );
    }
    lines.push("");
    lines.push("### By hard case");
    lines.push("");
    // TP/FP/FN/TN are shown beside the ratios because a hard-case subset is small
    // enough that either ratio can be VACUOUS — a subset with no unsupported case
    // scores recall 1.00 for finding nothing, and one with no true positive scores
    // precision 0.00 or 1.00 on a single decision. The counts make that visible.
    lines.push("| Hard case | Cases | Recall | Precision | TP | FP | FN | TN |");
    lines.push("|-----------|-------|--------|-----------|----|----|----|----|");
    for (const h of Object.values(a.summary.runs[0].byHardCase)) {
      lines.push(
        `| ${h.kind} | ${h.caseCount} | ${pct(h.recall)} | ${pct(h.precision)} | ` +
          `${h.truePositives} | ${h.falsePositives} | ${h.falseNegatives} | ${h.trueNegatives} |`,
      );
    }
    lines.push("");
    if (a.thresholds) {
      lines.push("### Thresholds");
      lines.push("");
      for (const c of a.checks) {
        lines.push(
          `- ${c.passed ? "✅" : "❌"} \`${c.metric}\` ${pct(c.value)} (${c.direction} ${pct(c.bound)})`,
        );
      }
    } else {
      lines.push(
        "> No registered floors for this arm. Its bar is the comparison against the baseline " +
          "measured in the same run, not an absolute number guessed in advance.",
      );
    }
    lines.push("");
  }

  lines.push("## Provenance");
  lines.push("");
  lines.push(`> ${report.corpus.provenanceNote}`);
  lines.push("");
  return lines.join("\n");
}

/**
 * Render ONE case in full — finding text, both citation sets, retrieval health,
 * every evidence excerpt, the ground-truth rationale, and each arm's verdict.
 * #1108 requires the hard cases to be "individually inspectable"; a table row is
 * not enough to dispute a label, and a label nobody can dispute is not evidence.
 */
export function renderCaseDetail(
  corpus: VerificationCorpus,
  caseId: string,
  arms: ArmRunSummary[],
): string {
  const c: VerificationCase | undefined = corpus.cases.find((x) => x.id === caseId);
  if (!c) {
    throw new Error(
      `unknown case ${JSON.stringify(caseId)}. Known: ${corpus.cases.map((x) => x.id).join(", ")}.`,
    );
  }
  const lines: string[] = [];
  lines.push(`# ${c.id} — ${c.title}`);
  lines.push("");
  lines.push(`Hard case: **${c.hardCase}** · Provenance: **${c.provenance.origin}**`);
  lines.push("");
  lines.push(`Source: ${c.provenance.source}`);
  lines.push(`Ground truth established by: ${c.provenance.groundTruth}`);
  lines.push("");
  lines.push("## Finding as the agent emitted it");
  lines.push("");
  lines.push(`**${c.finding.title}**`);
  lines.push("");
  lines.push(c.finding.body);
  lines.push("");
  lines.push("## What the verifier sees");
  lines.push("");
  lines.push(`- Grounded citations (survived the #734 gate): ${c.groundedCitations.length}`);
  for (const g of c.groundedCitations) lines.push(`  - ${JSON.stringify(g)}`);
  lines.push(`- Dropped citations: ${c.droppedCitations.length}`);
  for (const d of c.droppedCitations) lines.push(`  - ${d.filePath} (${d.reason})`);
  lines.push(`- Absence claim confirmable by this run's retrieval: ${c.absenceConfirmable}`);
  lines.push("");
  lines.push("## Evidence the agent was given");
  lines.push("");
  if (c.evidence.length === 0) lines.push("_(none — a citation-free claim)_");
  for (const e of c.evidence) {
    lines.push(`### ${e.filePath}:${e.startLine}-${e.endLine}`);
    lines.push("");
    lines.push("```");
    lines.push(e.excerpt);
    lines.push("```");
    lines.push("");
  }
  lines.push("## Ground truth");
  lines.push("");
  lines.push(`**supported: ${c.expected.supported}** — ${c.expected.rationale}`);
  lines.push("");
  lines.push("## Arm verdicts");
  lines.push("");
  for (const a of arms) {
    const s = a.runs[0].scores.find((x) => x.id === caseId);
    lines.push(`- \`${a.armId}\` → ${s?.status ?? "null (no signal)"} (${s?.outcome ?? "?"})`);
  }
  lines.push("");
  return lines.join("\n");
}

/** Parse `--case <id>` for the single-case inspection mode. */
export function parseCaseId(argv: string[]): string | null {
  const i = argv.indexOf("--case");
  const next = i >= 0 ? argv[i + 1] : undefined;
  return next && !next.startsWith("--") ? next : null;
}
