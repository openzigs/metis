import { describe, expect, it } from "vitest";
import type { LocalizationArm } from "./arms.js";
import type { LocalizationCorpus, LocalizationItem } from "./corpus.js";
import type { CostMeter } from "./cost.js";
import {
  EvalBudget,
  compareArms,
  memoisedA0TableGuard,
  poolHeldOutReports,
  runLocalizationEval,
  toMarkdownReport,
  toPooledMarkdownReport,
  type TableGuardReading,
} from "./runner.js";

function items(n: number): LocalizationItem[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `I-${i + 1}`,
    title: `Requirement ${i + 1}`,
    text: "Something a business analyst wants.",
    expectedFiles: [`r:want${i + 1}.ts`],
    expectedRepos: ["r"],
    source: { kind: "authored" as const },
  }));
}

function corpus(
  n: number,
  purpose: "held-out" | "in-sample" = "held-out",
  id: LocalizationCorpus["name"] = "localization-02-fixture-portfolio",
): LocalizationCorpus {
  const its = items(n);
  return {
    name: id,
    dir: "/nowhere",
    manifest: {
      id,
      description: "t",
      purpose,
      license: "CC0-1.0",
      repos: [{ name: "r", url: "https://x/r", ref: "main", sha: "0123456789abcdef" }],
      symbols: "s",
      annotation: {
        rewrittenBy: "p",
        rewrittenAt: "d",
        sawDiffsBeforeRewriting: false,
        procedure: "x",
        reviewedBy: null,
      },
      items: its,
    },
    symbols: [],
    graphFiles: new Set(its.flatMap((i) => i.expectedFiles)),
  };
}

/** An arm that finds the expected file at `rankOf(item)` (1-based), or not at all (0). */
function arm(
  id: string,
  rankOf: (item: LocalizationItem) => number,
  onCall?: () => void,
): LocalizationArm {
  return {
    id,
    label: `${id} test arm`,
    configuration: { llm: id !== "A0" },
    async localize(item) {
      onCall?.();
      const rank = rankOf(item);
      const filler = Array.from({ length: 12 }, (_, i) => `r:noise${i}.ts`);
      if (rank > 0) filler.splice(rank - 1, 0, item.expectedFiles[0]!);
      return { rankedFiles: filler, editCandidateFiles: filler.slice(0, 2) };
    },
  };
}

class FakeMeter implements CostMeter {
  spent = 0;
  unpriced = 0;
  spentUsd() {
    return this.spent;
  }
  unpricedCalls() {
    return this.unpriced;
  }
}

describe("runLocalizationEval", () => {
  it("requires A0 first", async () => {
    await expect(
      runLocalizationEval(corpus(2), { arms: [arm("A4", () => 1)], meter: new FakeMeter() }),
    ).rejects.toThrow(/A0 must be the first arm/);
  });

  it("runs every arm run-major, scores it and compares it with A0", async () => {
    const order: string[] = [];
    let clock = 0;
    const report = await runLocalizationEval(corpus(30), {
      arms: [
        arm(
          "A0",
          (i) => (Number(i.id.slice(2)) % 2 === 0 ? 1 : 0),
          () => order.push("A0"),
        ),
        arm(
          "A4",
          () => 1,
          () => order.push("A4"),
        ),
      ],
      runs: 2,
      meter: new FakeMeter(),
      now: () => (clock += 500),
    });
    expect(order.slice(0, 31)).toEqual([...Array(30).fill("A0"), "A4"]);
    const [a0, a4] = report.arms;
    expect(a0!.completedRuns).toBe(2);
    expect(a0!.aggregate.recallAt5).toBe(0.5);
    expect(a4!.aggregate.recallAt5).toBe(1);
    expect(a0!.aggregate.secondsPerRequirement).toBe(0.5);
    expect(a0!.tableGuard).toEqual({
      measured: false,
      reason: "not requested (pass --table-guard)",
    });
    const cmp = report.comparisons[0]!;
    expect(cmp.items).toBe(30);
    expect(cmp.metrics.find((m) => m.metric === "recallAt5")!.verdict).toBe("better");
    expect(cmp.hits[0]).toMatchObject({ k: 5, b: 0, c: 15, verdict: "better" });
    expect(cmp.hits[1]).toMatchObject({ k: 10, b: 0, c: 15, verdict: "better" });
    expect(report.stopped).toBeNull();
    expect(report.scoredRuns).toBe(2);
    expect(report.partialFirstRun).toBe(false);
    expect(report.notes).toEqual([]);
    expect(report.detectableGap).toMatch(/^At 30 items/);
  });

  it("stops before the budget would be exceeded", async () => {
    const meter = new FakeMeter();
    const report = await runLocalizationEval(corpus(10), {
      arms: [
        arm(
          "A0",
          () => 1,
          () => (meter.spent += 0.4),
        ),
      ],
      runs: 3,
      budgetUsd: 1,
      meter,
    });
    // $0.40 per requirement: after two, $0.80 + $0.40 would pass $1.
    expect(report.stopped).toMatchObject({ arm: "A0", run: 1, item: "I-3" });
    expect(report.stopped!.reason).toMatch(/^budget/);
    expect(report.spentUsd).toBeCloseTo(0.8);
    expect(report.arms[0]!.completedRuns).toBe(0);
    expect(report.arms[0]!.items).toHaveLength(2);
    expect(report.arms[0]!.aggregate.costUsdPerRequirement).toBeCloseTo(0.4);
  });

  it("stops on an unpriced call: unknown spend cannot be held under a cap", async () => {
    const meter = new FakeMeter();
    const report = await runLocalizationEval(corpus(3), {
      arms: [
        arm(
          "A0",
          () => 1,
          () => (meter.unpriced += 1),
        ),
      ],
      meter,
    });
    expect(report.stopped).toMatchObject({ reason: "an unpriced model call", item: "I-2" });
    expect(report.arms[0]!.items[0]!.costUsd).toBeNull();
  });

  it("reads the table guard per arm and gates the drop against A0", async () => {
    const readings: Record<string, TableGuardReading> = {
      A0: { measured: true, tablePrecision: 0.78, runs: 3, configuration: "prod" },
      A4: { measured: true, tablePrecision: 0.74, runs: 3, configuration: "prod" },
    };
    const report = await runLocalizationEval(corpus(4), {
      arms: [arm("A0", () => 1), arm("A4", () => 1)],
      runs: 1,
      meter: new FakeMeter(),
      tableGuard: async (a) => readings[a.id]!,
    });
    expect(report.comparisons[0]!.tableGuardPassed).toBe(false);
    readings.A4 = { measured: true, tablePrecision: 0.76, runs: 3, configuration: "prod" };
    const again = await runLocalizationEval(corpus(4), {
      arms: [arm("A0", () => 1), arm("A4", () => 1)],
      runs: 1,
      meter: new FakeMeter(),
      tableGuard: async (a) => readings[a.id]!,
    });
    expect(again.comparisons[0]!.tableGuardPassed).toBe(true);
    const md = toMarkdownReport(again);
    expect(md).toContain("| A0 | 1.00 [1.00, 1.00]");
    expect(md).toContain("0.780 (3 runs)");
    expect(md).toContain("table precision guard (≤ 0.03 drop) | — | — | — | held |");
  });
});

describe("runLocalizationEval budget (#1770)", () => {
  /** A model-backed arm that spends `usd` per requirement through the meter. */
  const paid = (id: string, meter: FakeMeter, usd: number) =>
    arm(
      id,
      () => 1,
      () => (meter.spent += usd),
    );

  it("runs nothing at a budget of $0", async () => {
    const report = await runLocalizationEval(corpus(3), {
      arms: [arm("A0", () => 1)],
      budgetUsd: 0,
      meter: new FakeMeter(),
    });
    expect(report.stopped).toMatchObject({ arm: "A0", run: 1, item: "I-1" });
    expect(report.stopped!.reason).toBe("budget: $0.0000 spent of $0");
    expect(report.arms[0]!.items).toEqual([]);
  });

  it("carries the look-ahead across calls that share a budget, so a second corpus is not run blind", async () => {
    const meter = new FakeMeter();
    const budget = new EvalBudget(1);
    const first = await runLocalizationEval(corpus(2), {
      arms: [arm("A0", () => 1), paid("A4", meter, 0.4)],
      runs: 1,
      budget,
      meter,
    });
    expect(first.stopped).toBeNull();
    expect(first.budgetUsd).toBe(1);
    const second = await runLocalizationEval(corpus(2), {
      arms: [arm("A0", () => 1), paid("A4", meter, 0.4)],
      runs: 1,
      budget,
      meter,
    });
    // $0.80 spent; A4's next requirement may cost $0.40, which would pass $1.
    expect(second.stopped).toMatchObject({ arm: "A4", run: 1, item: "I-1" });
    expect(meter.spent).toBeCloseTo(0.8);
  });

  it("keeps the look-ahead per arm: a paid arm's cost does not stop a free one", async () => {
    const meter = new FakeMeter();
    const report = await runLocalizationEval(corpus(2), {
      arms: [arm("A0", () => 1), paid("A4", meter, 0.4)],
      runs: 2,
      budgetUsd: 0.9,
      meter,
    });
    // Run 2: A0 is free and runs both items; A4's next $0.40 would pass $0.90.
    expect(report.stopped).toMatchObject({ arm: "A4", run: 2, item: "I-1" });
    expect(report.arms.map((a) => a.completedRuns)).toEqual([2, 1]);
  });

  it("refuses a run count that is not a positive integer, and an ambiguous budget", async () => {
    const opts = { arms: [arm("A0", () => 1)], meter: new FakeMeter() };
    await expect(runLocalizationEval(corpus(1), { ...opts, runs: 0 })).rejects.toThrow(
      /runs must be a positive integer, not 0/,
    );
    await expect(runLocalizationEval(corpus(1), { ...opts, runs: 1.5 })).rejects.toThrow(
      /positive integer/,
    );
    await expect(
      runLocalizationEval(corpus(1), { ...opts, budgetUsd: 1, budget: new EvalBudget(1) }),
    ).rejects.toThrow(/not both/);
    expect(() => new EvalBudget(-1)).toThrow(/non-negative/);
    expect(() => new EvalBudget(Number.NaN)).toThrow(/non-negative/);
  });

  it("never runs the table guard after the run stopped", async () => {
    const meter = new FakeMeter();
    let guardCalls = 0;
    const report = await runLocalizationEval(corpus(3), {
      arms: [paid("A0", meter, 0.4)],
      runs: 1,
      budgetUsd: 1,
      meter,
      tableGuard: async () => {
        guardCalls++;
        return { measured: true, tablePrecision: 0.8, runs: 3, configuration: "prod" };
      },
    });
    expect(report.stopped).toMatchObject({ item: "I-3" });
    expect(guardCalls).toBe(0);
    expect(report.arms[0]!.tableGuard).toEqual({
      measured: false,
      reason: expect.stringMatching(/^skipped: the run stopped \(budget/) as string,
    });
  });

  it("holds the table guard under the cap, with its own look-ahead", async () => {
    const meter = new FakeMeter();
    let guardCalls = 0;
    const report = await runLocalizationEval(corpus(2), {
      arms: [arm("A0", () => 1), arm("A4", () => 1)],
      runs: 1,
      budgetUsd: 0.7,
      meter,
      tableGuard: async () => {
        guardCalls++;
        meter.spent += 0.5;
        return { measured: true, tablePrecision: 0.8, runs: 3, configuration: "prod" };
      },
    });
    // A0's guard cost $0.50; another would pass $0.70, so A4's is skipped and the run stops.
    expect(guardCalls).toBe(1);
    expect(report.arms[0]!.tableGuard.measured).toBe(true);
    expect(report.arms[1]!.tableGuard).toMatchObject({ measured: false });
    // The stop names its phase and the run A4 reached, not a sentinel item (#1779).
    expect(report.stopped).toEqual({
      phase: "table-guard",
      reason: "budget: $0.5000 spent + up to $0.5000 next > $0.7",
      arm: "A4",
      run: 1,
      item: null,
    });
    expect(toMarkdownReport(report)).toContain("before arm A4's table-precision guard.");
  });

  it("names the requirement phase and the run reached on an item stop (#1779)", async () => {
    const meter = new FakeMeter();
    const report = await runLocalizationEval(corpus(2), {
      arms: [paid("A0", meter, 0.4)],
      runs: 3,
      budgetUsd: 1,
      meter,
    });
    expect(report.stopped).toEqual({
      phase: "requirement",
      reason: "budget: $0.8000 spent + up to $0.4000 next > $1",
      arm: "A0",
      run: 2,
      item: "I-1",
    });
  });
});

describe("memoisedA0TableGuard (#1779)", () => {
  /** The CLI's guard over a fake measurement that spends `usd` through the meter. */
  function cliGuard(meter: FakeMeter, usd: number) {
    let measured = 0;
    const guard = memoisedA0TableGuard(async () => {
      measured++;
      meter.spent += usd;
      return { measured: true, tablePrecision: 0.8, runs: 3, configuration: "prod" };
    });
    return { guard, measured: () => measured };
  }

  it("does not stop before a free guard: another arm's, or A0's memoised reading", async () => {
    // The reviewer's reproduction: a $0.70 cap and a first guard at $0.50, two arms.
    const meter = new FakeMeter();
    const budget = new EvalBudget(0.7);
    const { guard, measured } = cliGuard(meter, 0.5);
    const opts = { arms: [arm("A0", () => 1), arm("A4", () => 1)], runs: 1, budget, meter };
    const first = await runLocalizationEval(corpus(2), { ...opts, tableGuard: guard });
    expect(first.stopped).toBeNull();
    expect(first.arms[0]!.tableGuard).toMatchObject({ measured: true, tablePrecision: 0.8 });
    expect(first.arms[1]!.tableGuard).toEqual({
      measured: false,
      reason: "arm A4 does not wire a table-precision run yet",
    });
    // A second corpus near the cap: A0's cached reading costs nothing and is kept.
    const second = await runLocalizationEval(corpus(2), { ...opts, tableGuard: guard });
    expect(second.stopped).toBeNull();
    expect(second.arms[0]!.tableGuard).toMatchObject({ measured: true, tablePrecision: 0.8 });
    expect(measured()).toBe(1);
    expect(meter.spent).toBeCloseTo(0.5);
  });

  it("still holds A0's first, paid reading under the cap", async () => {
    const meter = new FakeMeter();
    const budget = new EvalBudget(0.7);
    budget.observeGuard(0.5);
    meter.spent = 0.3;
    const { guard, measured } = cliGuard(meter, 0.5);
    const report = await runLocalizationEval(corpus(1), {
      arms: [arm("A0", () => 1)],
      runs: 1,
      budget,
      meter,
      tableGuard: guard,
    });
    expect(measured()).toBe(0);
    expect(report.stopped).toMatchObject({ phase: "table-guard", arm: "A0" });
    expect(report.arms[0]!.tableGuard).toMatchObject({ measured: false });
  });

  it("reads a free guard even after an item stop: it spends nothing", async () => {
    const meter = new FakeMeter();
    const budget = new EvalBudget(1);
    const { guard } = cliGuard(meter, 0.1);
    await runLocalizationEval(corpus(1), {
      arms: [arm("A0", () => 1)],
      runs: 1,
      budget,
      meter,
      tableGuard: guard,
    });
    const report = await runLocalizationEval(corpus(3), {
      arms: [
        arm("A0", () => 1),
        arm(
          "A4",
          () => 1,
          () => (meter.spent += 0.4),
        ),
      ],
      runs: 1,
      budget,
      meter,
      tableGuard: guard,
    });
    expect(report.stopped).toMatchObject({ phase: "requirement", arm: "A4" });
    expect(report.arms[0]!.tableGuard).toMatchObject({ measured: true });
    expect(report.arms[1]!.tableGuard).toEqual({
      measured: false,
      reason: "arm A4 does not wire a table-precision run yet",
    });
  });
});

describe("runLocalizationEval with unequal runs (#1770)", () => {
  it("scores every arm on the runs all of them completed, and says what it dropped", async () => {
    const meter = new FakeMeter();
    const report = await runLocalizationEval(corpus(2), {
      arms: [
        arm("A0", () => 1),
        arm(
          "A4",
          () => 0,
          () => (meter.spent += 0.4),
        ),
      ],
      runs: 2,
      budgetUsd: 0.9,
      meter,
    });
    const [a0, a4] = report.arms;
    expect(report.scoredRuns).toBe(1);
    expect(report.partialFirstRun).toBe(false);
    expect(a0!.droppedRunScores).toBe(2);
    expect(a0!.perItemRuns["I-1"]).toHaveLength(2);
    expect(a0!.items.every((s) => s.runs === 1)).toBe(true);
    expect(a4!.droppedRunScores).toBe(0);
    expect(toMarkdownReport(report)).toContain(
      "> **Unequal runs.** Every arm is scored on the 1 run(s) all arms completed; dropped: A0 2 item score(s).",
    );
  });

  it("says when run 1 itself is incomplete and the arms cover different items", async () => {
    const meter = new FakeMeter();
    const report = await runLocalizationEval(corpus(3), {
      arms: [
        arm("A0", () => 1),
        arm(
          "A4",
          () => 1,
          () => (meter.spent += 0.4),
        ),
      ],
      runs: 1,
      budgetUsd: 0.5,
      meter,
    });
    expect(report.partialFirstRun).toBe(true);
    expect(report.scoredRuns).toBe(1);
    expect(report.comparisons[0]!.items).toBe(1);
    expect(toMarkdownReport(report)).toContain(
      "> **Run 1 is incomplete.** The arms scored different items (A0: 3, A4: 1)",
    );
  });
});

describe("corpus notes (#1770)", () => {
  it("says Recall@10 carries no signal when the graph has ten files or fewer", async () => {
    const report = await runLocalizationEval(corpus(10), {
      arms: [arm("A0", () => 1)],
      runs: 1,
      meter: new FakeMeter(),
    });
    expect(report.notes).toHaveLength(1);
    expect(toMarkdownReport(report)).toContain(
      "> **Note.** The code graph holds only 10 files, so an arm that ranks all of them scores Recall@10 = 1.00 by construction",
    );
    const big = await runLocalizationEval(corpus(11), {
      arms: [arm("A0", () => 1)],
      runs: 1,
      meter: new FakeMeter(),
    });
    expect(big.notes).toEqual([]);
  });
});

describe("poolHeldOutReports (#1770)", () => {
  async function reportOf(
    n: number,
    purpose: "held-out" | "in-sample",
    id: LocalizationCorpus["name"],
    armRank: (item: LocalizationItem) => number,
  ) {
    return runLocalizationEval(corpus(n, purpose, id), {
      arms: [arm("A0", (i) => (Number(i.id.slice(2)) % 2 === 0 ? 1 : 0)), arm("A4", armRank)],
      runs: 1,
      meter: new FakeMeter(),
    });
  }

  it("compares each arm with A0 over every held-out item, stratified by corpus", async () => {
    const miniflux = await reportOf(12, "held-out", "localization-01-miniflux-heldout", () => 1);
    const fixture = await reportOf(8, "held-out", "localization-02-fixture-portfolio", () => 7);
    const inSample = await reportOf(
      6,
      "in-sample",
      "localization-00-miniflux-run7-insample",
      () => 1,
    );
    const pooled = poolHeldOutReports([miniflux, fixture, inSample]);
    expect(pooled.corpora.map((c) => c.id)).toEqual([
      "localization-01-miniflux-heldout",
      "localization-02-fixture-portfolio",
    ]);
    expect(pooled.items).toBe(20);
    expect(pooled.corpora.map((c) => c.stopped)).toEqual([null, null]);
    const [cmp] = pooled.comparisons;
    expect(cmp).toMatchObject({
      arm: "A4",
      items: 20,
      strata: [
        { corpus: "localization-01-miniflux-heldout", items: 12 },
        { corpus: "localization-02-fixture-portfolio", items: 8 },
      ],
    });
    // A0 hits the even items (10 of 20). A4 hits every Miniflux item at rank 1 and
    // every fixture item at rank 7: discordant at k=5 b=4 (fixture evens), c=6
    // (Miniflux odds); at k=10 b=0, c=10.
    expect(cmp!.hits).toMatchObject([
      { k: 5, b: 4, c: 6 },
      { k: 10, b: 0, c: 10, verdict: "better" },
    ]);
    const r10 = cmp!.metrics.find((m) => m.metric === "recallAt10")!;
    expect(r10.n).toBe(20);
    expect(r10.meanDifference).toBeCloseTo(0.5, 12);
    expect(pooled.detectableGap).toMatch(/^At 20 items/);
    const md = toPooledMarkdownReport(pooled);
    expect(md).toContain("# Localization eval — held-out corpora pooled");
    expect(md).toContain("`localization-01-miniflux-heldout` (12 items, 1 scored run(s))");
    expect(md).toContain("| A4 | hit@10 (McNemar, b=0, c=10) | +10 items |");
    expect(md).not.toContain("run7-insample");
  });

  it("sizes the detectable gap on the paired items, and says which corpus stopped (#1779)", async () => {
    const meter = new FakeMeter();
    const budget = new EvalBudget(0.9);
    const opts = {
      arms: [
        arm("A0", () => 1),
        arm(
          "A4",
          () => 1,
          () => (meter.spent += 0.4),
        ),
      ],
      runs: 1,
      budget,
      meter,
    };
    const full = await runLocalizationEval(
      corpus(10, "held-out", "localization-01-miniflux-heldout"),
      { ...opts, arms: [arm("A0", () => 1), arm("A4", () => 1)] },
    );
    // A0 scores all 10 fixture items; A4 only 2 before the cap.
    const partial = await runLocalizationEval(
      corpus(10, "held-out", "localization-02-fixture-portfolio"),
      opts,
    );
    expect(partial.stopped).not.toBeNull();
    const pooled = poolHeldOutReports([full, partial]);
    expect(pooled.items).toBe(20);
    expect(pooled.comparisons[0]!.items).toBe(12);
    expect(pooled.comparisons[0]!.detectableGap).toMatch(/^At 12 items/);
    expect(pooled.detectableGap).toMatch(/^At 12 items/);
    expect(pooled.corpora.map((c) => c.stopped)).toEqual([null, partial.stopped!.reason]);
    const md = toPooledMarkdownReport(pooled);
    expect(md).toContain(
      `\`localization-02-fixture-portfolio\` (10 items, 1 scored run(s), run 1 incomplete, stopped early: ${partial.stopped!.reason})`,
    );
    expect(md).toContain("> A4 pairs 12 of A0's 20 items. At 12 items");
  });

  it("refuses fewer than two held-out reports and says when there is no arm to compare", async () => {
    const one = await reportOf(4, "held-out", "localization-01-miniflux-heldout", () => 1);
    const inSample = await reportOf(
      4,
      "in-sample",
      "localization-00-miniflux-run7-insample",
      () => 1,
    );
    expect(() => poolHeldOutReports([one, inSample])).toThrow(
      /two or more held-out reports, got 1/,
    );
    const a0Only = (id: LocalizationCorpus["name"]) =>
      runLocalizationEval(corpus(4, "held-out", id), {
        arms: [arm("A0", () => 1)],
        runs: 1,
        meter: new FakeMeter(),
      });
    const pooled = poolHeldOutReports([
      await a0Only("localization-01-miniflux-heldout"),
      await a0Only("localization-02-fixture-portfolio"),
    ]);
    expect(pooled.comparisons).toEqual([]);
    expect(toPooledMarkdownReport(pooled)).toContain("nothing to compare with A0");
  });
});

describe("compareArms", () => {
  it("pairs only the items both arms scored and reports an unmeasured guard as null", async () => {
    const report = await runLocalizationEval(corpus(4), {
      arms: [arm("A0", () => 1), arm("A4", () => 0)],
      runs: 1,
      meter: new FakeMeter(),
    });
    const [a0, a4] = report.arms;
    const cmp = compareArms(a0!, { ...a4!, items: a4!.items.slice(0, 3) });
    expect(cmp.items).toBe(3);
    expect(cmp.hits[0]).toMatchObject({ b: 3, c: 0, verdict: "no measurable difference" });
    expect(cmp.tableGuardPassed).toBeNull();
  });
});

describe("toMarkdownReport", () => {
  it("names each arm's configuration, the corpus purpose, an early stop and the detectable gap", async () => {
    const meter = new FakeMeter();
    const report = await runLocalizationEval(corpus(3, "in-sample"), {
      arms: [
        arm(
          "A0",
          () => 2,
          () => (meter.spent += 1),
        ),
        arm("A4", () => 0),
      ],
      runs: 1,
      budgetUsd: 2.5,
      meter,
    });
    const md = toMarkdownReport(report);
    expect(md).toContain("> **IN-SAMPLE.**");
    expect(md).toContain("### A0 test arm");
    expect(md).toContain("| llm | false |");
    expect(md).toContain("> **Stopped early** (budget");
    expect(md).toContain("> At 3 items and a hit rate near 0.5");
    expect(md).toContain("| A4 | recallAt5 |");
    expect(md).toContain("hit@5 (McNemar");
    expect(md).toContain("| I-1 | 1.00 / 1.00 / 0.50 / 0.50 |");
    expect(md).toContain("not measured");
  });

  it("says when A0 ran alone", async () => {
    const report = await runLocalizationEval(corpus(1), {
      arms: [arm("A0", () => 1)],
      runs: 1,
      meter: new FakeMeter(),
    });
    const md = toMarkdownReport(report);
    expect(md).toContain("No other arm was run: this report is A0's baseline.");
    expect(md).not.toContain("IN-SAMPLE");
  });
});
