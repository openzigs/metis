import { beforeAll, describe, expect, it } from "vitest";
import { EvalBudget } from "../localization/runner.js";
import type { AIProvider, ChatResponse } from "../../ai/types.js";
import type { AssessContext, GoverningArm } from "./arms.js";
import {
  loadGoverningCorpus,
  shortAnswerPairs,
  type GoverningCorpus,
  type GoverningItem,
} from "./corpus.js";
import { A0_BY_CONSTRUCTION } from "./arms.js";
import {
  ESTIMATED_CALL_TOKENS,
  SCREEN_SIZE_RULE_COUNTS,
  SpendLedger,
  estimateCallUsd,
  setStatement,
  TokenLedgerMeter,
  combineGoverningReports,
  compareWithA0,
  provenanceStatement,
  readingPaths,
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

describe("the set a reading came from (#2024)", () => {
  it("labels a reading of the held-out set as held out, with its content hash", async () => {
    const heldOut = await loadGoverningCorpus("governing-02-clinic-records");
    const report = await runGoverningEval(heldOut, {
      arms: [fakeArm("A0", resemblingOnly)],
      runs: 1,
      budget: new EvalBudget(100),
      provider: fakeProvider(),
    });
    const hash = heldOut.manifest.contentHash!.value;
    expect(report.corpus).toMatchObject({
      id: "governing-02-clinic-records",
      purpose: "held-out",
      contentHash: hash,
    });
    const md = toMarkdownReport(report);
    expect(md).toContain(
      `Set: **held-out** (read for a decision, never tuned on; content hash \`${hash}\`).`,
    );
    expect(md).not.toContain("**tuning**");
    expect(JSON.parse(toJsonReport(report)).corpus.purpose).toBe("held-out");
  });

  it("states a held-out set without a hash as such, rather than printing nothing", () => {
    expect(setStatement({ purpose: "held-out", contentHash: null })).toContain(
      "content hash `none`",
    );
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

  it("marks a pass cell ‡ from the broken-claim flag, not from the presence of a note (#2032)", async () => {
    const report = await runGoverningEval(corpus, {
      arms: [fakeArm("A0", resemblingOnly)],
      runs: 1,
      budget: new EvalBudget(100),
      provider: fakeProvider(),
    });
    const thresholds = report.arms[0]!.thresholds;
    const recall = thresholds.find((t) => t.bar === "overallRecall")!;
    const precision = thresholds.find((t) => t.bar === "precision")!;
    // A judged bar may carry an explanatory note without any claim behind it.
    recall.note = "measured on one run only";
    delete recall.brokenClaim;
    precision.brokenClaim = true;
    const md = toMarkdownReport(report);
    expect(md).toMatch(/\| A0 \| overallRecall \| ≥ 0\.90 \| [\d.]+ \| (?:yes|\*\*no\*\*) \|/);
    expect(md).toMatch(/\| A0 \| precision \| ≥ 0\.60 \| [\d.]+ \| (?:yes|\*\*no\*\*)‡ \|/);
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
    // #2024 — the report says which set the reading came from.
    expect(report.corpus).toMatchObject({ purpose: "tuning", contentHash: null });
    expect(md).toContain("Set: **tuning** (prompts are iterated on this set");
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

describe("the short-answer pairs' own row (#2033)", () => {
  /**
   * A fake replaying arm: before any answer it asks on every truth pair; after
   * the answers it reads every short answer as meeting its rule — right on a
   * "Yes", and on GR-11's "No.", wrong on every other "No.".
   */
  const readsEveryAnswerAsMet = (item: GoverningItem): GoverningArmOutput => ({
    judgements: item.applies.map((p) => ({ ruleId: p.ruleId, verdict: "needs-ba-input" as const })),
    ...(shortAnswerPairs(item).length > 0
      ? {
          answered: {
            judgements: shortAnswerPairs(item).map((p) => ({
              ruleId: p.ruleId,
              verdict: "compliant" as const,
            })),
          },
        }
      : {}),
  });
  const replaying = (opts: Parameters<typeof fakeArm>[2] = {}) => ({
    ...fakeArm("A4", readsEveryAnswerAsMet, opts),
    replaysAnswers: true,
  });

  it("scores the findings after each answer against answeredVerdict, apart from the main results", async () => {
    const report = await runGoverningEval(corpus, {
      arms: [replaying()],
      runs: 2,
      budget: new EvalBudget(100),
      provider: fakeProvider(),
    });
    const arm = report.arms[0]!;
    // 7 pairs; 4 are labelled compliant once answered (GR-11's "No." among them).
    expect(arm.shortAnswers).toMatchObject({
      runs: 2,
      pairs: 7,
      foundPerRun: [7, 7],
      hardErrors: 6,
      hardErrorsPerRun: [3, 3],
      askedPerRun: [0, 0],
      failures: 0,
    });
    expect(arm.shortAnswers!.verdictAccuracy.perRun).toEqual([4 / 7, 4 / 7]);
    // The main results read the findings before any answer: no compliant, so no hard error.
    expect(arm.summary.hardErrors).toBe(0);
    const gr11 = arm.records.find((r) => r.itemId === "GR-11" && r.run === 1)!;
    expect(gr11.answeredPairs).toEqual([
      {
        ruleId: "DR-06",
        answer: "No.",
        truth: "compliant",
        verdict: "compliant",
        hardError: false,
      },
    ]);
    expect(arm.records.find((r) => r.itemId === "GR-01")!.answeredPairs).toBeUndefined();

    const md = toMarkdownReport(report);
    expect(md).toContain("## Short-answer pairs, with the BA's answer replayed (#2033)");
    expect(md).toMatch(
      /\| A4 \| 2 \| 7 \| 0\.57 \[[\d.]+, [\d.]+\] \| 7\/7 \| 6 \| 0\/0 \| 0 \| 0 \|/,
    );
    // #2041 — the failure column says what it counts, and the replay's cost is flagged.
    expect(md).toContain("| Still asking | Settle failures | Requirements failed |");
    expect(md).toContain(
      "Requirements failed: requirements with short-answer pairs on which the arm threw, before or during the replay",
    );
    expect(md).toContain(
      "A4: $ / req, tokens, s / req and the cap's per-requirement estimate include the replay of the BA's answers (#2033), " +
        "so they are not comparable with readings of the same arm from before #2033.",
    );
    expect(md).not.toContain("No run completed");
    expect(md).toContain('- GR-08 → PR-05 ("No.", labelled gap): compliant, compliant');
    expect(md).toContain('- GR-11 → DR-06 ("No.", labelled compliant): compliant, compliant');
    // The row sits before the comparison with A0.
    expect(md.indexOf("## Short-answer pairs")).toBeLessThan(md.indexOf("## Paired comparison"));

    // The JSON keeps each record's answered findings and leaves the derived outcomes out.
    const parsed = JSON.parse(toJsonReport(report)) as typeof report;
    const back = parsed.arms[0]!.records.find((r) => r.itemId === "GR-11")!;
    expect(back.answered).toEqual(gr11.answered);
    expect(back).not.toHaveProperty("answeredPairs");
    expect(parsed.arms[0]!.shortAnswers).toEqual(arm.shortAnswers);
  });

  it("scores the short-answer pairs of a requirement the arm failed on as misses and a failure", async () => {
    const report = await runGoverningEval(corpus, {
      arms: [replaying({ throwOn: "GR-11" })],
      runs: 1,
      budget: new EvalBudget(100),
      provider: fakeProvider(),
    });
    const s = report.arms[0]!.shortAnswers!;
    expect(s).toMatchObject({ pairs: 7, foundPerRun: [6], failures: 1, hardErrorsPerRun: [3] });
    expect(s.verdictAccuracy.perRun).toEqual([3 / 7]);
    expect(toMarkdownReport(report)).toContain(
      '- GR-11 → DR-06 ("No.", labelled compliant): missed',
    );
  });

  it("scores a pair the settle failed on as a settle failure, not as still asking (#2041)", async () => {
    // GR-11's settle failed: the finding left for DR-06 is the reading before the answer.
    const settleFailedOnGr11 = (item: GoverningItem): GoverningArmOutput => {
      const out = readsEveryAnswerAsMet(item);
      if (item.id !== "GR-11") return out;
      return {
        ...out,
        answered: {
          judgements: [{ ruleId: "DR-06", verdict: "needs-ba-input" }],
          settleFailures: ["DR-06"],
        },
      };
    };
    const report = await runGoverningEval(corpus, {
      arms: [{ ...fakeArm("A4", settleFailedOnGr11), replaysAnswers: true }],
      runs: 1,
      budget: new EvalBudget(100),
      provider: fakeProvider(),
    });
    const s = report.arms[0]!.shortAnswers!;
    expect(s).toMatchObject({ askedPerRun: [0], settleFailures: 1, failures: 0, foundPerRun: [6] });
    expect(s.verdictAccuracy.perRun).toEqual([3 / 7]);
    const md = toMarkdownReport(report);
    expect(md).toMatch(/\| A4 \| 1 \| 7 \| 0\.43 \[[\d.]+, [\d.]+\] \| 6 \| 3 \| 0 \| 1 \| 0 \|/);
    expect(md).toContain('- GR-11 → DR-06 ("No.", labelled compliant): settle failed');
  });

  it("does not call a set without short answers when no run completed (#2041)", async () => {
    const report = await runGoverningEval(corpus, {
      arms: [replaying()],
      runs: 1,
      budget: new EvalBudget(PER_CALL_USD * 3.5),
      provider: fakeProvider(),
      callEstimateUsd: PER_CALL_USD,
    });
    expect(report.arms[0]!.completedRuns).toBe(0);
    expect(report.arms[0]!.shortAnswers).toMatchObject({ runs: 0, pairs: 7 });
    const md = toMarkdownReport(report);
    expect(md).not.toContain("This set has no short-answer pairs");
    expect(md).toContain("No run completed for A4, so no answer was scored there.");
  });

  it("lists each pair's verdicts from the scored runs only, not from a run the cap cut short", async () => {
    const items = corpus.manifest.items.length;
    // One full run, then run 2 stops after GR-08: GR-06 and GR-08 were answered in it too.
    const report = await runGoverningEval(corpus, {
      arms: [replaying()],
      runs: 2,
      budget: new EvalBudget(PER_CALL_USD * (items + 8.5)),
      provider: fakeProvider(),
      callEstimateUsd: PER_CALL_USD,
    });
    expect(report.arms[0]!.completedRuns).toBe(1);
    expect(report.arms[0]!.records.filter((r) => r.run === 2 && r.answeredPairs)).toHaveLength(2);
    expect(report.arms[0]!.shortAnswers).toMatchObject({ runs: 1, foundPerRun: [7] });
    const md = toMarkdownReport(report);
    expect(md).toContain('- GR-06 → VM-01 ("Yes, it has.", labelled compliant): compliant\n');
    expect(md).toContain('- GR-08 → PR-05 ("No.", labelled gap): compliant\n');
  });

  it("prints no row for an arm that does not replay answers, and says so on a set without short answers", async () => {
    const plain = await runGoverningEval(corpus, {
      arms: [fakeArm("A0", readsEveryAnswerAsMet)],
      runs: 1,
      budget: new EvalBudget(100),
      provider: fakeProvider(),
    });
    expect(plain.arms[0]!.shortAnswers).toBeNull();
    expect(toMarkdownReport(plain)).not.toContain("Short-answer pairs");
    expect(toMarkdownReport(plain)).not.toContain("include the replay");

    const bare: GoverningCorpus = {
      ...corpus,
      manifest: {
        ...corpus.manifest,
        items: corpus.manifest.items.map((i) => ({
          ...i,
          applies: i.applies.map(({ baAnswer: _a, answeredVerdict: _v, ...p }) => p),
        })),
      },
    };
    const none = await runGoverningEval(bare, {
      arms: [replaying()],
      runs: 1,
      budget: new EvalBudget(100),
      provider: fakeProvider(),
    });
    expect(none.arms[0]!.shortAnswers).toMatchObject({ pairs: 0, failures: 0 });
    expect(toMarkdownReport(none)).toContain(
      "This set has no short-answer pairs (`baAnswer`), so no answer was replayed.",
    );
    // Nothing was replayed, so the cost carries no replay.
    expect(toMarkdownReport(none)).not.toContain("include the replay");
  });
});

describe("the code a reading ran (#1878)", () => {
  const AT = { commit: "0123456789abcdef0123456789abcdef01234567", dirty: false } as const;

  it("records the commit, the tree state and each arm's code path, in the JSON and the markdown", async () => {
    const arm = { ...fakeArm("A5", resemblingOnly), codePath: ["step one", "step two"] };
    const report = await runGoverningEval(corpus, {
      arms: [arm, fakeArm("A0", resemblingOnly)],
      runs: 1,
      budget: new EvalBudget(100),
      provider: fakeProvider(),
      provenance: AT,
    });
    expect(report.provenance).toEqual({ ...AT, combinedFrom: [] });
    expect(report.arms.map((a) => a.codePath)).toEqual([["step one", "step two"], []]);
    const parsed = JSON.parse(toJsonReport(report)) as typeof report;
    expect(parsed.provenance.commit).toBe(AT.commit);
    expect(parsed.arms[0]!.codePath).toEqual(["step one", "step two"]);
    const md = toMarkdownReport(report);
    expect(md).toContain(`Code: commit \`${AT.commit}\`, clean tree.`);
    expect(md).toContain("Code path:\n\n1. step one\n2. step two");
  });

  it("says when the commit or the tree state is unknown, or the tree was dirty", async () => {
    const report = await runGoverningEval(corpus, {
      arms: [fakeArm("A0", resemblingOnly)],
      runs: 1,
      budget: new EvalBudget(100),
      provider: fakeProvider(),
    });
    expect(report.provenance).toEqual({ commit: null, dirty: null, combinedFrom: [] });
    expect(provenanceStatement(report.provenance)).toBe("**commit unknown**, tree state unknown.");
    expect(provenanceStatement({ commit: "abc", dirty: true, combinedFrom: [] })).toBe(
      "commit `abc`, **uncommitted changes**, so the commit does not name the code.",
    );
  });

  describe("combineGoverningReports", () => {
    /** Run 1 answers as the oracle, run 2 finds only the resembling pairs. */
    const byRun = (items: number) => {
      let calls = 0;
      return (item: GoverningItem) =>
        calls++ < items ? oracle(() => corpus)(item) : resemblingOnly(item);
    };
    const oneRun = async (
      answer: (item: GoverningItem) => GoverningArmOutput,
      provenance: { commit: string | null; dirty: boolean | null } = AT,
      over: Partial<GoverningArm> = {},
    ) =>
      JSON.parse(
        toJsonReport(
          await runGoverningEval(corpus, {
            arms: [{ ...fakeArm("A5", answer), codePath: ["p"], ...over }],
            runs: 1,
            budget: new EvalBudget(100),
            provider: fakeProvider(),
            provenance,
          }),
        ),
      ) as unknown;

    it("scores two one-run invocations exactly as one two-run invocation", async () => {
      const items = corpus.manifest.items.length;
      const direct = await runGoverningEval(corpus, {
        arms: [{ ...fakeArm("A5", byRun(items)), codePath: ["p"] }],
        runs: 2,
        budget: new EvalBudget(100),
        provider: fakeProvider(),
        provenance: AT,
      });
      const combined = combineGoverningReports(corpus, [
        { source: "one.json", report: await oneRun(oracle(() => corpus)) },
        { source: "two.json", report: await oneRun(resemblingOnly) },
      ]);
      const [d, c] = [direct.arms[0]!, combined.arms[0]!];
      expect(c.completedRuns).toBe(2);
      expect(c.summary).toEqual(d.summary);
      expect(c.thresholds).toEqual(d.thresholds);
      expect(c.records.map((r) => r.run)).toEqual(d.records.map((r) => r.run));
      expect(c.records.map((r) => r.pairs)).toEqual(d.records.map((r) => r.pairs));
      expect(c.codePath).toEqual(["p"]);
      expect(combined.runsRequested).toBe(2);
      expect(combined.spentUsd).toBeCloseTo(direct.spentUsd, 10);
      expect(combined.provenance).toEqual({
        ...AT,
        combinedFrom: ["one.json", "two.json"],
      });
      expect(toMarkdownReport(combined)).toContain(
        "combined from 2 invocations (`one.json`, `two.json`)",
      );
    });

    it("re-scores the short-answer pairs of an arm that replays answers", async () => {
      const replay = (item: GoverningItem): GoverningArmOutput => ({
        judgements: [],
        ...(shortAnswerPairs(item).length > 0
          ? {
              answered: {
                judgements: shortAnswerPairs(item).map((p) => ({
                  ruleId: p.ruleId,
                  verdict: p.answeredVerdict,
                })),
              },
            }
          : {}),
      });
      const saved = await oneRun(replay, AT, { replaysAnswers: true });
      const combined = combineGoverningReports(corpus, [{ source: "a.json", report: saved }]);
      expect(combined.arms[0]!.shortAnswers).toMatchObject({ runs: 1, pairs: 7 });
      expect(combined.arms[0]!.shortAnswers!.verdictAccuracy.perRun).toEqual([1]);
      const gr11 = combined.arms[0]!.records.find((r) => r.itemId === "GR-11")!;
      expect(gr11.answeredPairs).toEqual([expect.objectContaining({ verdict: "compliant" })]);
    });

    it("refuses invocations that do not make one reading", async () => {
      const good = await oneRun(resemblingOnly);
      const combine = (other: unknown) =>
        combineGoverningReports(corpus, [
          { source: "good.json", report: good },
          { source: "bad.json", report: other },
        ]);
      expect(() => combineGoverningReports(corpus, [])).toThrow(/nothing to combine/);
      const otherCommit = await oneRun(resemblingOnly, { ...AT, commit: "f".repeat(40) });
      expect(() => combine(otherCommit)).toThrow(
        /cannot combine bad\.json: it ran at f{40}, not 0123/,
      );
      const dirty = await oneRun(resemblingOnly, { ...AT, dirty: true });
      expect(() => combine(dirty)).toThrow(/uncommitted changes/);
      const unknownTree = await oneRun(resemblingOnly, { ...AT, dirty: null });
      expect(() => combine(unknownTree)).toThrow(/uncommitted changes/);
      const noCommit = await oneRun(resemblingOnly, { commit: null, dirty: false });
      expect(() => combine(noCommit)).toThrow(/records no commit/);
      const otherPath = await oneRun(resemblingOnly, AT, { codePath: ["q"] });
      expect(() => combine(otherPath)).toThrow(/other arms, or the same arms configured otherwise/);
      const stopped = JSON.parse(
        toJsonReport(
          await runGoverningEval(corpus, {
            arms: [{ ...fakeArm("A5", resemblingOnly), codePath: ["p"] }],
            runs: 1,
            budget: new EvalBudget(0),
            provider: fakeProvider(),
            provenance: AT,
          }),
        ),
      ) as unknown;
      expect(() => combine(stopped)).toThrow(/stopped early/);
      const heldOut = await loadGoverningCorpus("governing-02-clinic-records");
      expect(() => combineGoverningReports(heldOut, [{ source: "g.json", report: good }])).toThrow(
        /it read governing-01-sample-policy, not governing-02-clinic-records/,
      );
      const rehashed = structuredClone(good) as { corpus: { contentHash: string } };
      rehashed.corpus.contentHash = "x";
      expect(() => combine(rehashed)).toThrow(/another content hash/);
    });
  });

  it("writes a reading beside the corpora, named baseline-<arm>-<model>, and refuses any other name", () => {
    expect(readingPaths("/repo", "governing-02-clinic-records", "baseline-A5-sonnet")).toEqual({
      json: "/repo/eval-data/readings/governing-02-clinic-records/baseline-A5-sonnet.json",
      md: "/repo/eval-data/readings/governing-02-clinic-records/baseline-A5-sonnet.md",
    });
    for (const bad of [
      "../x",
      "baseline-A5",
      "A5-sonnet",
      "baseline-A5-../../x",
      "baseline-A5-Sonnet",
    ]) {
      expect(() => readingPaths("/repo", "governing-02-clinic-records", bad)).toThrow(
        /baseline-<arm>-<model>/,
      );
    }
    expect(() => readingPaths("/repo", "../etc", "baseline-A5-sonnet")).toThrow(/not a corpus/);
  });
});
