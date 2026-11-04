import { describe, expect, it } from "vitest";
import type { LocalizationArm } from "./arms.js";
import type { LocalizationCorpus, LocalizationItem } from "./corpus.js";
import type { CostMeter } from "./cost.js";
import {
  compareArms,
  runLocalizationEval,
  toMarkdownReport,
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

function corpus(n: number, purpose: "held-out" | "in-sample" = "held-out"): LocalizationCorpus {
  const its = items(n);
  return {
    name: "localization-02-fixture-portfolio",
    dir: "/nowhere",
    manifest: {
      id: "localization-02-fixture-portfolio",
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
    expect(report.stopped).toBeNull();
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
