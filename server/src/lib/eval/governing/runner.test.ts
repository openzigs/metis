import { beforeAll, describe, expect, it } from "vitest";
import { EvalBudget } from "../localization/runner.js";
import type { AIProvider, ChatResponse } from "../../ai/types.js";
import type { AssessContext, GoverningArm } from "./arms.js";
import { loadGoverningCorpus, type GoverningCorpus, type GoverningItem } from "./corpus.js";
import { A0_BY_CONSTRUCTION } from "./arms.js";
import {
  ESTIMATED_CALL_TOKENS,
  SCREEN_SIZE_RULE_COUNTS,
  SpendLedger,
  estimateCallUsd,
  TokenLedgerMeter,
  compareWithA0,
  runGoverningEval,
  toJsonReport,
  toMarkdownReport,
} from "./runner.js";
import type { GoverningArmOutput, ItemScore } from "./scorer.js";

let corpus: GoverningCorpus;
beforeAll(async () => {
  corpus = await loadGoverningCorpus("governing-01-sample-policy");
});

// claude-sonnet-5-5 is priced by the ledger: $2 / MTok in, $10 / MTok out.
const USAGE = { promptTokens: 1000, completionTokens: 100, totalTokens: 1100 };
const PER_CALL_USD = 0.003;

/** A provider whose every call reports {@link USAGE} under `model`. */
function fakeProvider(model = "claude-sonnet-5-5"): AIProvider {
  return {
    key: "anthropic",
    model,
    offline: false,
    async chat(): Promise<ChatResponse> {
      return { content: "{}", model, provider: "anthropic", usage: USAGE };
    },
  } as unknown as AIProvider;
}

/** A fake arm: one model call per requirement through the provider it is handed, then `answer(item)`. */
function fakeArm(
  id: string,
  answer: (item: GoverningItem) => GoverningArmOutput,
  opts: { throwOn?: string; message?: string; delayMs?: (item: GoverningItem) => number } = {},
): GoverningArm & { calls: number } {
  const arm = {
    id,
    label: `${id} — fake`,
    configuration: { fake: true },
    calls: 0,
    async assess(item: GoverningItem, _corpus: GoverningCorpus, { provider }: AssessContext) {
      arm.calls++;
      const delay = opts.delayMs?.(item) ?? 0;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      await provider.chat([{ role: "user", content: item.text }]);
      if (item.id === opts.throwOn) throw new Error(opts.message ?? "no JSON object in the reply");
      return answer(item);
    },
  };
  return arm;
}

/** The ground truth itself, verbatim citations included: a perfect arm. */
const oracle = (corpusRef: () => GoverningCorpus) => (item: GoverningItem) => ({
  judgements: item.applies.map((p) => ({
    ruleId: p.ruleId,
    verdict: p.verdict,
    citation: { ruleId: p.ruleId, excerpt: corpusRef().ruleById.get(p.ruleId)!.clause },
  })),
});
/** Finds only the pairs that resemble their requirement, always as compliant. */
const resemblingOnly = (item: GoverningItem) => ({
  judgements: item.applies
    .filter((p) => !p.nonResembling)
    .map((p) => ({ ruleId: p.ruleId, verdict: "compliant" as const })),
});

describe("runGoverningEval", () => {
  it("runs every arm on every requirement each run, and scores and compares them", async () => {
    const a0 = fakeArm("A0", resemblingOnly);
    const a2 = fakeArm(
      "A2",
      oracle(() => corpus),
    );
    let clock = 0;
    const report = await runGoverningEval(corpus, {
      arms: [a0, a2],
      runs: 2,
      budget: new EvalBudget(100),
      provider: fakeProvider(),
      now: () => (clock += 500),
    });
    const items = corpus.manifest.items.length;
    expect(a0.calls).toBe(items * 2);
    expect(a2.calls).toBe(items * 2);
    expect(report.stopped).toBeNull();
    const [r0, r2] = report.arms;
    expect(r0!.completedRuns).toBe(2);
    expect(r2!.summary.metrics.recall.mean).toBe(1);
    expect(r2!.summary.metrics.citationAccuracy.mean).toBe(1);
    expect(r2!.summary.hardErrors).toBe(0);
    expect(r2!.thresholds.every((t) => t.pass)).toBe(true);
    expect(r0!.summary.metrics.nonResemblingRecall.mean).toBe(0);
    expect(r0!.summary.hardErrors).toBeGreaterThan(0);
    expect(r0!.thresholds.find((t) => t.bar === "maxNoEvidenceCompliantErrors")!.pass).toBe(false);
    // Cost and tokens per requirement come from the ledger meter.
    expect(r0!.cost.usdPerRequirement).toBeCloseTo(PER_CALL_USD, 10);
    expect(r0!.cost.inputTokensPerRequirement).toBe(1000);
    expect(r0!.cost.completionTokensPerRequirement).toBe(100);
    expect(r0!.cost.secondsPerRequirement).toBe(0.5);
    expect(report.spentUsd).toBeCloseTo(PER_CALL_USD * items * 4, 10);
    const nr = report.comparisons.find(
      (c) => c.arm === "A2" && c.metric === "nonResemblingRecall",
    )!;
    expect(nr.difference.meanDifference).toBe(1);
    expect(nr.verdict).toBe("better");
    expect(toMarkdownReport(report)).toMatch(
      /\| A2 \| nonResemblingRecall \| \+1\.00 \| \[1\.00, 1\.00\] \| 0\.000 \| better \(n=11\) \|/,
    );
    expect(report.screenPromptSizes.map((s) => s.rules)).toEqual([...SCREEN_SIZE_RULE_COUNTS]);
    expect(report.corpus).toMatchObject({ rules: 40, revision: "v1", reviewedBy: null });
  });

  it("stops at the cap before a requirement it cannot afford, and scores only complete runs", async () => {
    const a0 = fakeArm(
      "A0",
      oracle(() => corpus),
    );
    const items = corpus.manifest.items.length;
    // Room for one full run and a few requirements of the next.
    const report = await runGoverningEval(corpus, {
      arms: [a0],
      runs: 3,
      budget: new EvalBudget(PER_CALL_USD * (items + 3.5)),
      provider: fakeProvider(),
      callEstimateUsd: PER_CALL_USD,
    });
    expect(report.stopped).toMatchObject({ arm: "A0", run: 2 });
    expect(report.stopped!.reason).toMatch(/^budget:/);
    expect(a0.calls).toBe(items + 3);
    expect(report.arms[0]!.completedRuns).toBe(1);
    expect(report.arms[0]!.records).toHaveLength(items + 3);
    expect(toMarkdownReport(report)).toMatch(
      /> \*\*Stopped\*\* before A0 on GR-0\d \(run 2\): budget:/,
    );
  });

  it("stops on an unpriced call instead of counting it as $0", async () => {
    const a0 = fakeArm(
      "A0",
      oracle(() => corpus),
    );
    const report = await runGoverningEval(corpus, {
      arms: [a0],
      runs: 1,
      budget: new EvalBudget(100),
      provider: fakeProvider("no-such-model"),
    });
    expect(a0.calls).toBe(1);
    expect(report.stopped).toMatchObject({ reason: "an unpriced model call", itemId: "GR-02" });
    expect(report.arms[0]!.records[0]!.costUsd).toBeNull();
    expect(report.arms[0]!.cost.totalUsd).toBeNull();
    expect(report.arms[0]!.cost.usdPerRequirement).toBeNull();
    expect(report.unpricedCalls).toBe(1);
  });

  it("scores a negative requirement the arm crashed on as an error, not a clean negative (#1900)", async () => {
    const negatives = corpus.manifest.items.filter((i) => i.applies.length === 0);
    const crashOn = negatives[0]!.id;
    const report = await runGoverningEval(corpus, {
      arms: [
        fakeArm(
          "A0",
          oracle(() => corpus),
          { throwOn: crashOn },
        ),
      ],
      runs: 1,
      budget: new EvalBudget(100),
      provider: fakeProvider(),
    });
    const arm = report.arms[0]!;
    expect(arm.failures).toBe(1);
    expect(arm.summary.negatives).toBe(negatives.length);
    // The oracle applies nothing on every negative; only the crash is not clean.
    expect(arm.summary.cleanNegatives).toEqual([negatives.length - 1]);
    expect(toMarkdownReport(report)).toContain(
      `| ${negatives.length - 1} of ${negatives.length} | 1 |`,
    );
  });

  it("records a requirement the arm failed on, scored as applying no rule", async () => {
    const logs: string[] = [];
    const a0 = fakeArm(
      "A0",
      oracle(() => corpus),
      { throwOn: "GR-01" },
    );
    const report = await runGoverningEval(corpus, {
      arms: [a0],
      runs: 1,
      budget: new EvalBudget(100),
      provider: fakeProvider(),
      log: (l) => logs.push(l),
    });
    const arm = report.arms[0]!;
    expect(arm.failures).toBe(1);
    expect(arm.records[0]).toMatchObject({ itemId: "GR-01", error: "no JSON object in the reply" });
    expect(arm.records[0]!.judgements).toEqual([]);
    expect(arm.summary.metrics.recall.mean).toBeLessThan(1);
    expect(logs.some((l) => l.includes("GR-01 run 1 failed"))).toBe(true);
  });

  it("prices each requirement on its own when several run at once, and reports them in corpus order", async () => {
    // Later requirements finish first, so completion order is the reverse of corpus order.
    const slowFirst = (item: GoverningItem) => 40 - corpus.manifest.items.indexOf(item);
    const serial = await runGoverningEval(corpus, {
      arms: [fakeArm("A0", resemblingOnly)],
      runs: 1,
      budget: new EvalBudget(100),
      provider: fakeProvider(),
    });
    const parallel = await runGoverningEval(corpus, {
      arms: [fakeArm("A0", resemblingOnly, { delayMs: slowFirst })],
      runs: 1,
      budget: new EvalBudget(100),
      provider: fakeProvider(),
      concurrency: 6,
    });
    const ids = (r: typeof serial) => r.arms[0]!.records.map((x) => x.itemId);
    expect(ids(parallel)).toEqual(ids(serial));
    for (const r of parallel.arms[0]!.records) expect(r.costUsd).toBeCloseTo(PER_CALL_USD, 12);
    expect(parallel.arms[0]!.summary.metrics).toEqual(serial.arms[0]!.summary.metrics);
    expect(parallel.spentUsd).toBeCloseTo(serial.spentUsd, 10);
  });

  it("reserves the costliest call for each one in flight, so concurrency cannot run past the cap", async () => {
    const a0 = fakeArm("A0", resemblingOnly, { delayMs: () => 5 });
    // Two calls' worth: with six in flight after the first, the reserve stops the rest.
    const report = await runGoverningEval(corpus, {
      arms: [a0],
      runs: 1,
      budget: new EvalBudget(PER_CALL_USD * 2),
      provider: fakeProvider(),
      concurrency: 6,
      callEstimateUsd: PER_CALL_USD,
    });
    expect(report.stopped?.reason).toMatch(/^budget:/);
    expect(report.spentUsd).toBeLessThanOrEqual(PER_CALL_USD * 6 + 1e-12);
    expect(a0.calls).toBeLessThan(corpus.manifest.items.length);
  });

  it("reserves the per-call estimate in the first wave, before any call has finished (#1900)", async () => {
    const a0 = fakeArm("A0", resemblingOnly, { delayMs: () => 5 });
    // Room for two and a half calls: six workers start at once, none has finished.
    const budgetUsd = PER_CALL_USD * 2.5;
    const report = await runGoverningEval(corpus, {
      arms: [a0],
      runs: 1,
      budget: new EvalBudget(budgetUsd),
      provider: fakeProvider(),
      concurrency: 6,
      callEstimateUsd: PER_CALL_USD,
    });
    expect(report.stopped?.reason).toMatch(/^budget:/);
    expect(a0.calls).toBe(2);
    expect(report.spentUsd).toBeLessThanOrEqual(budgetUsd);
  });

  it("estimates a call at the ledger's price for the provider's model, by default", async () => {
    // 6,000 in / 6,000 out at $2 / $10 per MTok.
    expect(ESTIMATED_CALL_TOKENS).toEqual({ input: 6_000, output: 6_000 });
    expect(estimateCallUsd(fakeProvider())).toBeCloseTo(0.072, 10);
    expect(estimateCallUsd(fakeProvider("no-such-model"))).toBe(0);
    // A budget below one estimated call starts nothing.
    const a0 = fakeArm("A0", resemblingOnly);
    const report = await runGoverningEval(corpus, {
      arms: [a0],
      runs: 1,
      budget: new EvalBudget(0.05),
      provider: fakeProvider(),
    });
    expect(a0.calls).toBe(0);
    expect(report.stopped?.reason).toMatch(/up to \$0\.0720 next/);
  });
});

describe("the per-call estimate (#1920)", () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, -0.01])(
    "refuses %s before any call, since it would switch the cap off or shrink the reserve",
    async (callEstimateUsd) => {
      const a0 = fakeArm("A0", resemblingOnly);
      await expect(
        runGoverningEval(corpus, {
          arms: [a0],
          runs: 1,
          budget: new EvalBudget(100),
          provider: fakeProvider(),
          callEstimateUsd,
        }),
      ).rejects.toThrow(/per-call estimate must be a non-negative number of dollars/);
      expect(a0.calls).toBe(0);
    },
  );

  it("accepts an estimate of zero", async () => {
    const report = await runGoverningEval(corpus, {
      arms: [fakeArm("A0", resemblingOnly)],
      runs: 1,
      budget: new EvalBudget(100),
      provider: fakeProvider(),
      callEstimateUsd: 0,
    });
    expect(report.stopped).toBeNull();
  });
});

describe("SpendLedger", () => {
  it("adds a finished call's spend and reserves the costliest call for each in flight", () => {
    const ledger = new SpendLedger();
    const call = new TokenLedgerMeter();
    call.record("anthropic", "claude-sonnet-5-5", USAGE);
    ledger.begin();
    expect(ledger.capView().spentUsd()).toBe(0);
    ledger.end(call);
    ledger.begin();
    ledger.begin();
    expect(ledger.committedUsd()).toBeCloseTo(PER_CALL_USD, 10);
    expect(ledger.reservedUsd()).toBeCloseTo(2 * PER_CALL_USD, 10);
    expect(ledger.capView().spentUsd()).toBeCloseTo(3 * PER_CALL_USD, 10);
    const unpriced = new TokenLedgerMeter();
    unpriced.record("anthropic", "claude-sonnet-5-5", undefined);
    ledger.end(unpriced);
    expect(ledger.capView().unpricedCalls()).toBe(1);
  });

  it("reserves the estimate for calls in flight before any has finished, and a costlier call after", () => {
    const ledger = new SpendLedger(0.01);
    ledger.begin();
    ledger.begin();
    expect(ledger.reservedUsd()).toBeCloseTo(0.02, 10);
    const cheap = new TokenLedgerMeter();
    cheap.record("anthropic", "claude-sonnet-5-5", USAGE);
    ledger.end(cheap);
    // The estimate stays the floor: a cheaper finished call does not lower it.
    expect(ledger.reservedUsd()).toBeCloseTo(0.01, 10);
    const dear = new TokenLedgerMeter();
    dear.record("anthropic", "claude-sonnet-5-5", { ...USAGE, completionTokens: 2_000 });
    ledger.begin();
    ledger.end(dear);
    expect(ledger.reservedUsd()).toBeCloseTo(dear.spentUsd(), 10);
  });
});

describe("a failure's error", () => {
  it("is kept to one line of at most 300 characters", async () => {
    const dump = `[\n  {\n    "code": "invalid_value",\n${"    x\n".repeat(200)}  }\n]`;
    const report = await runGoverningEval(corpus, {
      arms: [fakeArm("A0", resemblingOnly, { throwOn: "GR-01", message: dump })],
      runs: 1,
      budget: new EvalBudget(100),
      provider: fakeProvider(),
    });
    const error = report.arms[0]!.records[0]!.error!;
    expect(error.startsWith('[ { "code": "invalid_value", x x')).toBe(true);
    expect(error).not.toMatch(/\n/);
    expect(error).toHaveLength(300);
  });
});

describe("compareWithA0", () => {
  it("compares nothing without an A0", () => {
    expect(compareWithA0(new Map([["A2", [[]]]]))).toEqual([]);
  });

  it("pools an item's counts over runs, not the mean of its per-run ratios (#1932)", () => {
    const score = (counts: Partial<ItemScore>): ItemScore =>
      ({ itemId: "GR-01", pairs: [], truth: 1, truePositives: 1, ...counts }) as ItemScore;
    // A0 cites nothing it applies, in both runs: coverage 0.
    const a0 = [[score({ applied: 1, cited: 0 })], [score({ applied: 1, cited: 0 })]];
    // A2 cites its one rule in run 1 (1/1) and none of three in run 2 (0/3).
    // Pooled that is 1/4 = 0.25; the run-mean of the ratios would be 0.50.
    const a2 = [[score({ applied: 1, cited: 1 })], [score({ applied: 3, cited: 0 })]];
    const coverage = compareWithA0(
      new Map([
        ["A0", a0],
        ["A2", a2],
      ]),
    ).find((c) => c.metric === "citationCoverage")!;
    expect(coverage.difference.n).toBe(1);
    expect(coverage.difference.meanDifference).toBeCloseTo(0.25, 10);
  });

  it("compares citation coverage with A0 too, over the items both arms applied a rule on (#1920)", async () => {
    // A0 applies the resembling pairs and cites none; A2 cites every rule it applies.
    const report = await runGoverningEval(corpus, {
      arms: [
        fakeArm("A0", resemblingOnly),
        fakeArm(
          "A2",
          oracle(() => corpus),
        ),
      ],
      runs: 2,
      budget: new EvalBudget(100),
      provider: fakeProvider(),
    });
    expect(report.comparisons.map((c) => c.metric)).toEqual([
      "recall",
      "nonResemblingRecall",
      "citationCoverage",
    ]);
    const coverage = report.comparisons.find((c) => c.metric === "citationCoverage")!;
    const bothApplied = corpus.manifest.items.filter((i) =>
      i.applies.some((p) => !p.nonResembling),
    ).length;
    expect(coverage.difference.n).toBe(bothApplied);
    expect(coverage.difference.meanDifference).toBe(1);
    expect(coverage.verdict).toBe("better");
    expect(toMarkdownReport(report)).toMatch(/\| A2 \| citationCoverage \| \+1\.00 \|/);
  });
});

describe("TokenLedgerMeter", () => {
  it("sums the tokens of every call it prices, and still counts a call with no usage as unpriced", () => {
    const meter = new TokenLedgerMeter();
    meter.record("anthropic", "claude-sonnet-5-5", USAGE);
    meter.record("anthropic", "claude-sonnet-5-5", undefined);
    expect(meter.inputTokens()).toBe(1000);
    expect(meter.completionTokens()).toBe(100);
    expect(meter.unpricedCalls()).toBe(1);
    expect(meter.spentUsd()).toBeCloseTo(PER_CALL_USD, 10);
  });

  it("counts cache reads and writes as input: the Anthropic wire reports them apart", () => {
    const meter = new TokenLedgerMeter();
    meter.record("anthropic", "claude-sonnet-5-5", {
      ...USAGE,
      promptTokens: 200,
      cacheReadTokens: 700,
      cacheWriteTokens: 100,
    });
    expect(meter.inputTokens()).toBe(1000);
  });
});

describe("toJsonReport", () => {
  it("writes one line per record, leaves the derived pairs out, and parses back to the report", async () => {
    const report = await runGoverningEval(corpus, {
      arms: [
        fakeArm("A0", resemblingOnly),
        fakeArm(
          "A2",
          oracle(() => corpus),
        ),
      ],
      runs: 1,
      budget: new EvalBudget(100),
      provider: fakeProvider(),
    });
    const json = toJsonReport(report, { generatedAt: "2026-11-06T00:00:00.000Z" });
    const parsed = JSON.parse(json) as typeof report & { generatedAt: string };
    expect(parsed.generatedAt).toBe("2026-11-06T00:00:00.000Z");
    expect(parsed.arms[1]!.records).toHaveLength(corpus.manifest.items.length);
    expect(parsed.arms[1]!.records[0]).not.toHaveProperty("pairs");
    const { pairs: _pairs, ...first } = report.arms[1]!.records[0]!;
    expect(parsed.arms[1]!.records[0]).toEqual(first);
    expect(parsed.arms[0]!.summary).toEqual(report.arms[0]!.summary);
    const recordLines = json.split("\n").filter((l) => l.startsWith('      {"itemId":'));
    expect(recordLines).toHaveLength(2 * corpus.manifest.items.length);
    expect(json.endsWith("}\n")).toBe(true);
  });

  it("writes an arm with no records as an empty list", async () => {
    const report = await runGoverningEval(corpus, {
      arms: [fakeArm("A0", resemblingOnly)],
      runs: 1,
      budget: new EvalBudget(0),
      provider: fakeProvider(),
    });
    expect(JSON.parse(toJsonReport(report)).arms[0].records).toEqual([]);
  });
});

describe("toMarkdownReport", () => {
  it("prints the measured value, not n/a, when a by-construction claim does not hold (#1920)", async () => {
    // Claims A0's construction, but says compliant on every truth pair.
    const allCompliant = (item: GoverningItem) => ({
      judgements: item.applies.map((p) => ({ ruleId: p.ruleId, verdict: "compliant" as const })),
    });
    const arm = { ...fakeArm("A0", allCompliant), byConstruction: A0_BY_CONSTRUCTION };
    const report = await runGoverningEval(corpus, {
      arms: [arm],
      runs: 1,
      budget: new EvalBudget(100),
      provider: fakeProvider(),
    });
    const hardErrors = report.arms[0]!.summary.hardErrors;
    expect(hardErrors).toBeGreaterThan(0);
    const md = toMarkdownReport(report);
    // #1932 — the broken claim is marked ‡ in its cells, not only in the footnote.
    expect(md).toMatch(
      /\| A0 \| maxNoEvidenceCompliantErrors \| ≤ 0 per run \| \d+ \(worst run\) \| \*\*no\*\*‡ \|/,
    );
    // The results row shows the real hard-error count, marked; ask rate and citation accuracy still hold.
    expect(md).toContain(`| ${hardErrors}‡ | n/a† |`);
    // A bar no claim covers is not marked.
    expect(md).toMatch(/\| A0 \| precision \| ≥ 0\.60 \| [\d.]+ \| (?:yes|\*\*no\*\*) \|/);
    expect(md).toContain(
      "‡ Claimed fixed by construction, but measured otherwise, so it is judged: A0 hardErrors.",
    );
  });

  it("states the metrics, the bars, the review status, the screen size and each arm's configuration", async () => {
    const report = await runGoverningEval(corpus, {
      arms: [fakeArm("A0", resemblingOnly)],
      runs: 1,
      budget: new EvalBudget(100),
      provider: fakeProvider(),
    });
    const md = toMarkdownReport(report);
    expect(md).toContain("# Governing-rules eval — `governing-01-sample-policy`");
    expect(md).toContain("**not yet reviewed by a person**");
    expect(md).toContain("| Arm | Runs | Recall | Non-resembling recall | Precision |");
    expect(md).toMatch(
      /\| A0 \| maxNoEvidenceCompliantErrors \| ≤ 0 per run \| \d+ \(worst run\) \| \*\*no\*\* \|/,
    );
    expect(md).toContain("No other arm was run: this report is A0's baseline.");
    expect(md).toMatch(/\| 500 \| \d+ \| \d+ \|/);
    expect(md).toContain("| fake | true |");
    expect(md).toMatch(/Non-resembling pairs missed in every run: GR-01 → AL-02;/);
    expect(md).toMatch(/Hard errors: GR-02 → AC-03 \(run 1\);/);
  });

  it("prints n/a, never yes, for a bar the arm cannot fail by construction (#1900)", async () => {
    // Every truth pair judged gap, citing nothing: 0 hard errors by construction.
    const allGap = (item: GoverningItem) => ({
      judgements: item.applies.map((p) => ({ ruleId: p.ruleId, verdict: "gap" as const })),
    });
    const arm = { ...fakeArm("A0", allGap), byConstruction: A0_BY_CONSTRUCTION };
    const report = await runGoverningEval(corpus, {
      arms: [arm],
      runs: 1,
      budget: new EvalBudget(100),
      provider: fakeProvider(),
    });
    expect(report.arms[0]!.summary.hardErrors).toBe(0);
    expect(report.arms[0]!.byConstruction).toEqual(A0_BY_CONSTRUCTION);
    const md = toMarkdownReport(report);
    expect(md).toContain(
      "| A0 | maxNoEvidenceCompliantErrors | ≤ 0 per run | 0 (worst run) | n/a† |",
    );
    expect(md).toMatch(/\| A0 \| citationAccuracy \| ≥ 0\.95 \| n\/a \| n\/a† \|/);
    expect(md).toMatch(/\| A0 \| overallRecall \| ≥ 0\.90 \| 1\.00 \| yes \|/);
    // Hard errors and ask rate in the results row are n/a too.
    expect(md).toMatch(/\| n\/a† \| [^|]+ \| [^|]+ \| n\/a† \| n\/a† \| \d+ of \d+ \|/);
    expect(md).toContain(
      "† Fixed by construction, so it measures nothing and its bar is `n/a`: " +
        "A0 hardErrors: A0 judges every rule gap, so it never says compliant;",
    );
    // An arm that fixes nothing gets no note.
    const plain = await runGoverningEval(corpus, {
      arms: [fakeArm("A0", allGap)],
      runs: 1,
      budget: new EvalBudget(100),
      provider: fakeProvider(),
    });
    const plainMd = toMarkdownReport(plain);
    expect(md).not.toContain("‡");
    expect(plainMd).not.toContain("†");
    expect(plainMd).not.toContain("‡");
    expect(plainMd).toContain(
      "| A0 | maxNoEvidenceCompliantErrors | ≤ 0 per run | 0 (worst run) | yes |",
    );
  });
});
