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
  splitAgentPassesOf,
  toMarkdownReport,
  toPooledMarkdownReport,
  type TableGuardReading,
} from "./runner.js";
import type { AgentRunStats, ItemRunScore } from "./scorer.js";

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
      A0: {
        measured: true,
        tablePrecision: 0.78,
        runs: 3,
        configuration: "prod",
        seeding: "mapper",
      },
      A4: {
        measured: true,
        tablePrecision: 0.74,
        runs: 3,
        configuration: "prod",
        seeding: "mapper",
      },
    };
    const report = await runLocalizationEval(corpus(4), {
      arms: [arm("A0", () => 1), arm("A4", () => 1)],
      runs: 1,
      meter: new FakeMeter(),
      tableGuard: async (a) => readings[a.id]!,
    });
    expect(report.comparisons[0]!.tableGuardPassed).toBe(false);
    readings.A4 = {
      measured: true,
      tablePrecision: 0.76,
      runs: 3,
      configuration: "prod",
      seeding: "mapper",
    };
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
        return {
          measured: true,
          tablePrecision: 0.8,
          runs: 3,
          configuration: "prod",
          seeding: "mapper",
        };
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
        return {
          measured: true,
          tablePrecision: 0.8,
          runs: 3,
          configuration: "prod",
          seeding: "mapper",
        };
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
      return {
        measured: true,
        tablePrecision: 0.8,
        runs: 3,
        configuration: "prod",
        seeding: "mapper",
      };
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
    // #1800 — A4's 8 unscored requirements are counted next to the stop.
    expect(pooled.corpora.map((c) => c.missingScores)).toEqual([0, 8]);
    const md = toPooledMarkdownReport(pooled);
    expect(md).toContain(
      `\`localization-02-fixture-portfolio\` (10 items, 1 scored run(s), run 1 incomplete, stopped early: ${partial.stopped!.reason}, 8 requirement score(s) missing)`,
    );
    expect(md).toContain("`localization-01-miniflux-heldout` (10 items, 1 scored run(s)),");
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

describe("a table guard read on another seeding (#1786)", () => {
  const mapper = { tablePrecision: 0.78, runs: 3, configuration: "prod", seeding: "mapper" };
  const splitA0 = { tablePrecision: 0.5, runs: 3, configuration: "split", seeding: "split" };

  it("gates the arm against A0 on the arm's own seeding, and says which seeding each reading used", async () => {
    const readings: Record<string, TableGuardReading> = {
      A0: { measured: true, ...mapper },
      // 0.52 is far below A0's mapper reading, but above A0 on the split seeding.
      A4: {
        measured: true,
        tablePrecision: 0.52,
        runs: 3,
        configuration: "split + check",
        seeding: "split + edit-candidate check",
        baseline: splitA0,
      },
    };
    const run = () =>
      runLocalizationEval(corpus(4), {
        arms: [arm("A0", () => 1), arm("A4", () => 1)],
        runs: 1,
        meter: new FakeMeter(),
        tableGuard: async (a) => readings[a.id]!,
      });
    const report = await run();
    expect(report.comparisons[0]!.tableGuardPassed).toBe(true);
    const md = toMarkdownReport(report);
    expect(md).toContain("| 0.520 (3 runs; A0 on its seeding 0.500) |");
    expect(md).toContain("- A0 table precision (seeding: mapper) measured on: prod");
    expect(md).toContain(
      "- A4 table precision (seeding: split + edit-candidate check) measured on: split + check",
    );
    expect(md).toContain(
      "  - next to A0 on the same seeding (seeding: split): 0.500 (3 runs), measured on: split",
    );
    // More than 0.03 below A0 on the split seeding fails, whatever A0's mapper reading.
    readings.A4 = { ...(readings.A4 as object), tablePrecision: 0.46 } as TableGuardReading;
    expect((await run()).comparisons[0]!.tableGuardPassed).toBe(false);
  });

  it("is unread when neither the arm's baseline nor A0 was measured", async () => {
    const report = await runLocalizationEval(corpus(2), {
      arms: [arm("A0", () => 1), arm("A4", () => 1)],
      runs: 1,
      meter: new FakeMeter(),
      tableGuard: async (a) =>
        a.id === "A0"
          ? { measured: false, reason: "no" }
          : { measured: true, tablePrecision: 0.9, runs: 3, configuration: "c", seeding: "split" },
    });
    expect(report.comparisons[0]!.tableGuardPassed).toBeNull();
  });
});

describe("memoisedA0TableGuard with another arm's measurement (#1786)", () => {
  it("measures each wired arm once, free afterwards, and leaves an unwired arm unmeasured at no cost", async () => {
    const calls: string[] = [];
    const reading =
      (id: string): (() => Promise<TableGuardReading>) =>
      async () => {
        calls.push(id);
        return { measured: true, tablePrecision: 0.5, runs: 3, configuration: id, seeding: id };
      };
    const guard = memoisedA0TableGuard(reading("A0"), { A4: reading("A4") });
    const named = (id: string) => arm(id, () => 1);
    expect(guard.isFree?.(named("A4"))).toBe(false);
    expect(guard.isFree?.(named("A2"))).toBe(true);
    expect(await guard(named("A4"))).toMatchObject({ configuration: "A4" });
    expect(await guard(named("A4"))).toMatchObject({ configuration: "A4" });
    expect(guard.isFree?.(named("A4"))).toBe(true);
    expect(guard.isFree?.(named("A0"))).toBe(false);
    expect(await guard(named("A0"))).toMatchObject({ configuration: "A0" });
    expect(await guard(named("A2"))).toEqual({
      measured: false,
      reason: "arm A2 does not wire a table-precision run yet",
    });
    // An inherited property name is not a wired arm.
    expect(await guard(named("toString"))).toMatchObject({ measured: false });
    expect(calls).toEqual(["A4", "A0"]);
  });
});

describe("repository confinement in the report (#1784)", () => {
  it("counts the items whose edit candidates stayed in the answer's one repository, for a portfolio only", async () => {
    const one = corpus(2);
    const portfolio: LocalizationCorpus = {
      ...one,
      manifest: {
        ...one.manifest,
        repos: [...one.manifest.repos, { ...one.manifest.repos[0]!, name: "s" }],
      },
    };
    // A0 names a file of another repository on item 1; A12 stays in "r" on both.
    const named = (id: string, strays: boolean): LocalizationArm => ({
      id,
      label: id,
      configuration: {},
      async localize(item) {
        const edit = [item.expectedFiles[0]!, ...(strays && item.id === "I-1" ? ["s:x.ts"] : [])];
        return { rankedFiles: edit, editCandidateFiles: edit };
      },
    });
    const opts = {
      arms: [named("A0", true), named("A12", false)],
      runs: 1,
      meter: new FakeMeter(),
    };
    const report = await runLocalizationEval(portfolio, opts);
    expect(report.arms.map((a) => a.aggregate.repoConfinement)).toEqual([
      { confined: 1, of: 2 },
      { confined: 2, of: 2 },
    ]);
    expect(toMarkdownReport(report)).toContain(
      "Edit candidates only in the answer's repository (items with a one-repository answer): A0 1/2 · A12 2/2",
    );
    const single = await runLocalizationEval(one, opts);
    expect(toMarkdownReport(single)).not.toContain(
      "Edit candidates only in the answer's repository",
    );
  });
});

describe("agent arms: run context, reused work and turns (#1755)", () => {
  /** An arm that records the run it was asked for and reports reused work and turns. */
  function agentArm(id: string, out: Record<string, unknown>, runs: number[]): LocalizationArm {
    return {
      id,
      label: `${id} agent arm`,
      configuration: { llm: true },
      async localize(item, _corpus, context) {
        runs.push(context!.run);
        return {
          rankedFiles: [item.expectedFiles[0]!],
          editCandidateFiles: [item.expectedFiles[0]!],
          ...out,
        };
      },
    };
  }

  it("tells each arm the run, and adds reused cost and time to the reading's own", async () => {
    const seen: number[] = [];
    let t = 0;
    const meter = new FakeMeter();
    const report = await runLocalizationEval(corpus(2), {
      arms: [
        arm("A0", () => 1),
        agentArm("A3A", { reusedCostUsd: 0.25, reusedSeconds: 4, agentTurns: 7 }, seen),
      ],
      runs: 2,
      meter,
      now: () => (t += 1000),
    });
    expect(seen).toEqual([1, 1, 2, 2]);
    const a3a = report.arms[1]!;
    expect(a3a.items.map((s) => s.costUsd)).toEqual([0.25, 0.25]);
    // 1 s measured by the clock + 4 s reused.
    expect(a3a.items.map((s) => s.seconds)).toEqual([5, 5]);
    expect(a3a.aggregate.agentTurnsPerRequirement).toBe(7);
    expect(report.arms[0]!.aggregate.agentTurnsPerRequirement).toBeNull();
    expect(report.arms[0]!.items[0]).not.toHaveProperty("agentTurns");
    // The cap counts spend, not reused work: nothing was spent.
    expect(report.spentUsd).toBe(0);
    const md = toMarkdownReport(report);
    expect(md).toContain("Agent-loop turns per requirement: A3A 7.0");
  });

  it("reports a reading whose reused work was unpriced as unpriced", async () => {
    const report = await runLocalizationEval(corpus(1), {
      arms: [arm("A0", () => 1), agentArm("A3A", { reusedCostUsd: null, reusedSeconds: 1 }, [])],
      runs: 1,
      meter: new FakeMeter(),
    });
    expect(report.arms[1]!.items[0]!.costUsd).toBeNull();
    expect(toMarkdownReport(report)).not.toContain("Agent-loop turns");
  });
});

describe("--reference: pairing with an arm other than A0 (#1806)", () => {
  // A0 finds every even item first; A12 every item 2nd; A13 every item first.
  const arms = () => [
    arm("A0", (i) => (Number(i.id.slice(2)) % 2 === 0 ? 1 : 0)),
    arm("A12", () => 2),
    arm("A13", () => 1),
    arm("A13S", () => 1),
  ];
  const reportOf = (
    n: number,
    id: LocalizationCorpus["name"] = "localization-02-fixture-portfolio",
    references: string[] = ["A12", "A13"],
  ) =>
    runLocalizationEval(corpus(n, "held-out", id), {
      arms: arms(),
      runs: 1,
      meter: new FakeMeter(),
      references,
    });

  it("pairs every other arm with each reference, with the runner's own statistics", async () => {
    const report = await reportOf(12);
    expect(report.references).toEqual(["A12", "A13"]);
    expect(report.comparisons.map((c) => `${c.arm} vs ${c.baseline}`)).toEqual([
      "A12 vs A0",
      "A13 vs A0",
      "A13S vs A0",
    ]);
    expect(report.referenceComparisons.map((c) => `${c.arm} vs ${c.baseline}`)).toEqual([
      "A13 vs A12",
      "A13S vs A12",
      "A12 vs A13",
      "A13S vs A13",
    ]);
    const a13VsA12 = report.referenceComparisons[0]!;
    // A12 ranks the file 2nd (RR 0.5), A13 1st (RR 1): +0.5 on every item.
    expect(a13VsA12.metrics.find((m) => m.metric === "reciprocalRank")!.meanDifference).toBe(0.5);
    expect(a13VsA12.items).toBe(12);
    expect(a13VsA12.tableGuardPassed).toBeNull();
    const md = toMarkdownReport(report);
    expect(md).toContain("## Paired comparison with A12 (`--reference A12`)");
    expect(md).toContain("## Paired comparison with A13 (`--reference A13`)");
    expect(md).toContain("| A13S | reciprocalRank | +0.000 |");
    // The table-precision gate is A0's; a reference table does not repeat it.
    const a12Section = md.slice(md.indexOf("--reference A12"), md.indexOf("--reference A13"));
    expect(a12Section).toContain("| A13 | reciprocalRank | +0.500 |");
    expect(a12Section).not.toContain("table precision guard");
  });

  it("adds nothing when no reference is asked for", async () => {
    const report = await reportOf(4, undefined, []);
    expect(report.referenceComparisons).toEqual([]);
    expect(toMarkdownReport(report)).not.toContain("--reference");
  });

  it("says so when the reference is the only arm besides A0", async () => {
    const report = await runLocalizationEval(corpus(2), {
      arms: [arm("A0", () => 1), arm("A12", () => 2)],
      runs: 1,
      meter: new FakeMeter(),
      references: ["A12"],
    });
    expect(report.referenceComparisons).toEqual([]);
    expect(toMarkdownReport(report)).toContain(
      "No arm other than A0 and A12 was run: there is nothing to pair with it.",
    );
  });

  it("refuses a reference that is not one of the run's arms, or A0", async () => {
    await expect(reportOf(2, undefined, ["A4"])).rejects.toThrow(
      /--reference A4 is not one of this run's arms \(A0, A12, A13, A13S\)/,
    );
    await expect(reportOf(2, undefined, ["A0"])).rejects.toThrow(/--reference A0/);
  });

  it("pools the reference pairings over the held-out corpora, stratified by corpus", async () => {
    const miniflux = await reportOf(12, "localization-01-miniflux-heldout");
    const fixture = await reportOf(8, "localization-02-fixture-portfolio");
    const pooled = poolHeldOutReports([miniflux, fixture]);
    expect(pooled.referenceComparisons.map((c) => `${c.arm} vs ${c.baseline}`)).toEqual([
      "A13 vs A12",
      "A13S vs A12",
      "A12 vs A13",
      "A13S vs A13",
    ]);
    const a13VsA12 = pooled.referenceComparisons[0]!;
    expect(a13VsA12.items).toBe(20);
    expect(a13VsA12.strata).toEqual([
      { corpus: "localization-01-miniflux-heldout", items: 12 },
      { corpus: "localization-02-fixture-portfolio", items: 8 },
    ]);
    const md = toPooledMarkdownReport(pooled);
    expect(md).toContain("## Paired comparison with A12 (`--reference A12`), pooled");
    expect(md).toContain("| A13S | reciprocalRank | +0.000 |");
    // A reference pooled only when every held-out report carries it.
    const without = await reportOf(8, "localization-02-fixture-portfolio", ["A12"]);
    expect(
      poolHeldOutReports([miniflux, without]).referenceComparisons.map((c) => c.baseline),
    ).toEqual(["A12", "A12"]);
  });
});

describe("agent-pass counts and split passes in the report (#1810)", () => {
  const stats = (over: Partial<AgentRunStats> = {}): AgentRunStats => ({
    passes: 2,
    unanswered: 1,
    toolCalls: 6,
    citedFiles: 4,
    unresolvedFiles: 1,
    passGroup: "graph",
    passIds: ["p1", "p2"],
    ...over,
  });
  /** An agent arm whose readings carry `agentOf(item, run)`. */
  function passArm(
    id: string,
    agentOf: (item: LocalizationItem, run: number) => AgentRunStats,
  ): LocalizationArm {
    return {
      id,
      label: `${id} agent arm`,
      configuration: { llm: true },
      async localize(item, _corpus, context) {
        return {
          rankedFiles: [item.expectedFiles[0]!],
          editCandidateFiles: [item.expectedFiles[0]!],
          llmNamedFiles: [item.expectedFiles[0]!],
          agentTurns: 8,
          agent: agentOf(item, context!.run),
        };
      },
    };
  }
  const portfolioOf = (n: number): LocalizationCorpus => {
    const one = corpus(n);
    return {
      ...one,
      manifest: {
        ...one.manifest,
        repos: [...one.manifest.repos, { ...one.manifest.repos[0]!, name: "s" }],
      },
    };
  };

  it("sums the passes' counts and reports unanswered passes, per-pass turns and the rate before the resolve step", async () => {
    const report = await runLocalizationEval(portfolioOf(2), {
      arms: [arm("A0", () => 1), passArm("A3A", () => stats())],
      runs: 2,
      meter: new FakeMeter(),
    });
    expect(report.arms[1]!.aggregate.agent).toEqual({
      readings: 4,
      passes: 8,
      turns: 32,
      unanswered: 4,
      toolCalls: 24,
      citedFiles: 16,
      unresolvedFiles: 4,
    });
    expect(report.arms[0]!.aggregate.agent).toBeNull();
    const md = toMarkdownReport(report);
    expect(md).toContain(
      "Agent-loop turns per requirement (summed over the 2 repositories' passes, one pass per repository): A3A 8.0",
    );
    expect(md).toContain(
      "- A3A agent passes: 8 over 4 reading(s), 4 without a schema-valid answer; 4.0 turns and 3.0 tool calls per pass; " +
        "cited files in the code graph before the resolve step: 12 of 16 (0.75).",
    );
    expect(md).toContain("so it reads 1.00 by construction");
    expect(md).not.toContain("Separate agent passes");
  });

  it("does not call the turns a sum on one repository, and says when no file was cited", async () => {
    const report = await runLocalizationEval(corpus(1), {
      arms: [
        arm("A0", () => 1),
        passArm("A3N", () => stats({ passes: 1, citedFiles: 0, unresolvedFiles: 0 })),
      ],
      runs: 1,
      meter: new FakeMeter(),
    });
    const md = toMarkdownReport(report);
    expect(md).toContain("Agent-loop turns per requirement: A3N 8.0");
    expect(md).toContain("before the resolve step: n/a (no file cited).");
  });

  it("records the requirement-runs where A3 and A3A read different passes, and only those", async () => {
    // I-2 run 1 was scored by A3 in one invocation and A3A in another: two passes.
    const ids = (arm: string) => (item: LocalizationItem, run: number) =>
      stats({
        passIds: [item.id === "I-2" && run === 1 ? `${arm}-${item.id}` : `${item.id}-${run}`],
      });
    const report = await runLocalizationEval(corpus(3), {
      arms: [
        arm("A0", () => 1),
        passArm("A3", ids("A3")),
        passArm("A3A", ids("A3A")),
        // A3N reads its own passes, in its own group: never a split with A3.
        passArm("A3N", (item) => stats({ passGroup: "files", passIds: [`n-${item.id}`] })),
      ],
      runs: 2,
      meter: new FakeMeter(),
    });
    expect(report.splitAgentPasses).toEqual([
      { group: "graph", arms: ["A3", "A3A"], readings: [{ item: "I-2", run: 1 }] },
    ]);
    expect(toMarkdownReport(report)).toContain(
      "> **Separate agent passes.** A3 and A3A share one agent pass per requirement and run, " +
        "but read different passes on 1 requirement-run(s) (I-2 run 1)",
    );
  });

  it("reports an analysis arm's passes as analyses that persisted requirements (#1818)", async () => {
    const report = await runLocalizationEval(corpus(1), {
      arms: [
        arm("A0", () => 1),
        passArm("A7", () =>
          stats({ passes: 1, unanswered: 1, passGroup: "analysis", passIds: ["an-1"] }),
        ),
        passArm("A7O", () =>
          stats({ passes: 1, citedFiles: 0, unresolvedFiles: 0, passGroup: "analysis" }),
        ),
      ],
      runs: 1,
      meter: new FakeMeter(),
    });
    const md = toMarkdownReport(report);
    expect(md).toContain(
      '- A7 analyses ("Evaluate new requirements"): 1 over 1 reading(s), 1 that persisted no ' +
        "requirement (read as the pasted text); stored citations' files in the code graph: 3 of 4 (0.75).",
    );
    expect(md).toContain("stored citations' files in the code graph: n/a (no citation stored).");
    expect(md).not.toContain("A7 agent passes");
  });

  it("finds no split when an arm of the group has no reading, or none carries counts", () => {
    const score = (agent?: AgentRunStats) => ({ agent }) as unknown as ItemRunScore;
    expect(
      splitAgentPassesOf(["A3", "A3A"], ["I-1"], 1, (a) =>
        a === "A3" ? score(stats()) : undefined,
      ),
    ).toEqual([]);
    expect(splitAgentPassesOf(["A3", "A3A"], ["I-1"], 1, () => score())).toEqual([]);
  });
});
