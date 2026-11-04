import { describe, expect, it } from "vitest";
import {
  aggregateItems,
  averageRuns,
  graphResolutionRate,
  precisionOf,
  reciprocalRank,
  recallAtK,
  scoreObservation,
  type ItemRunScore,
} from "./scorer.js";

const ranked = ["r:a", "r:b", "r:c", "r:d", "r:e", "r:f", "r:g", "r:h", "r:i", "r:j", "r:k"];

describe("recallAtK", () => {
  it("counts expected files inside the cut only", () => {
    expect(recallAtK(ranked, ["r:a", "r:f"], 5)).toBe(0.5);
    expect(recallAtK(ranked, ["r:a", "r:f"], 10)).toBe(1);
    expect(recallAtK(ranked, ["r:k"], 10)).toBe(0);
  });

  it("dedupes the expected set", () => {
    expect(recallAtK(ranked, ["r:a", "r:a", "r:z"], 5)).toBe(0.5);
  });

  it("treats nothing to find as fully recalled (impact-recall convention)", () => {
    expect(recallAtK([], [], 5)).toBe(1);
  });
});

describe("precisionOf", () => {
  it("is the share of surfaced files that are expected", () => {
    expect(precisionOf(["r:a", "r:b", "r:c", "r:d"], ["r:a", "r:x"])).toBe(0.25);
  });

  it("treats nothing surfaced as nothing wrong (impact-recall convention)", () => {
    expect(precisionOf([], ["r:a"])).toBe(1);
  });
});

describe("reciprocalRank", () => {
  it("is one over the rank of the first expected file", () => {
    expect(reciprocalRank(ranked, ["r:c", "r:j"])).toBeCloseTo(1 / 3);
    expect(reciprocalRank(ranked, ["r:a"])).toBe(1);
  });

  it("is 0 when no expected file is ranked and 1 when nothing is expected", () => {
    expect(reciprocalRank(ranked, ["r:z"])).toBe(0);
    expect(reciprocalRank(ranked, [])).toBe(1);
  });
});

describe("graphResolutionRate", () => {
  const graph = new Set(["r:a", "r:b"]);
  it("is n/a for an arm that named nothing through a model", () => {
    expect(graphResolutionRate(undefined, graph)).toBeNull();
  });
  it("is 1 for an empty list and the resolved share otherwise", () => {
    expect(graphResolutionRate([], graph)).toBe(1);
    expect(graphResolutionRate(["r:a", "r:nope", "r:a"], graph)).toBe(0.5);
  });
});

describe("scoreObservation", () => {
  it("scores every metric of one run", () => {
    const s = scoreObservation(
      ["r:b", "r:z"],
      {
        rankedFiles: ranked,
        editCandidateFiles: ["r:a", "r:b"],
        llmNamedFiles: ["r:b", "r:q"],
        verdict: "gap",
        costUsd: 0.5,
        seconds: 2,
      },
      new Set(ranked),
      "partial",
    );
    expect(s).toEqual({
      recallAt5: 0.5,
      recallAt10: 0.5,
      editPrecision: 0.5,
      reciprocalRank: 0.5,
      graphResolution: 0.5,
      verdictCorrect: false,
      editCandidateCount: 2,
      costUsd: 0.5,
      seconds: 2,
    });
  });

  it("leaves the verdict unscored when either side has none", () => {
    const obs = { rankedFiles: [], editCandidateFiles: [], costUsd: 0, seconds: 0 };
    expect(scoreObservation(["r:a"], obs, new Set(), "gap").verdictCorrect).toBeNull();
    expect(
      scoreObservation(["r:a"], { ...obs, verdict: "gap" }, new Set()).verdictCorrect,
    ).toBeNull();
    expect(
      scoreObservation(["r:a"], { ...obs, verdict: "gap" }, new Set(), "gap").verdictCorrect,
    ).toBe(true);
  });
});

function run(over: Partial<ItemRunScore> = {}): ItemRunScore {
  return {
    recallAt5: 0,
    recallAt10: 0,
    editPrecision: 1,
    reciprocalRank: 0,
    graphResolution: null,
    verdictCorrect: null,
    editCandidateCount: 0,
    costUsd: 0,
    seconds: 1,
    ...over,
  };
}

describe("averageRuns", () => {
  it("means each metric and turns recall into a hit rate", () => {
    const s = averageRuns("I", [
      run({ recallAt5: 0.5, recallAt10: 1, verdictCorrect: true, graphResolution: 1, costUsd: 1 }),
      run({ recallAt5: 0, recallAt10: 0.5, verdictCorrect: false, costUsd: 3, seconds: 3 }),
    ]);
    expect(s).toMatchObject({
      runs: 2,
      recallAt5: 0.25,
      recallAt10: 0.75,
      hitAt5: 0.5,
      hitAt10: 1,
      verdictAccuracy: 0.5,
      graphResolution: 1,
      costUsd: 2,
      seconds: 2,
    });
  });

  it("reports cost as unknown when any run was unpriced", () => {
    expect(averageRuns("I", [run(), run({ costUsd: null })]).costUsd).toBeNull();
  });

  it("refuses to average nothing", () => {
    expect(() => averageRuns("I", [])).toThrow(/no runs/);
  });
});

describe("aggregateItems", () => {
  it("weights each requirement equally and counts the vacuous precisions", () => {
    const a = averageRuns("A", [
      run({
        recallAt5: 1,
        recallAt10: 1,
        editPrecision: 0.5,
        reciprocalRank: 1,
        editCandidateCount: 2,
        costUsd: 0.1,
      }),
    ]);
    const b = averageRuns("B", [run({ costUsd: 0.3 }), run({ costUsd: 0.3 })]);
    const g = aggregateItems([a, b]);
    expect(g).toMatchObject({
      items: 2,
      recallAt5: 0.5,
      recallAt10: 0.5,
      editPrecision: 0.75,
      mrr: 0.5,
      graphResolution: null,
      verdictAccuracy: null,
      itemsWithNoEditCandidate: 1,
      meanEditCandidates: 1,
      secondsPerRequirement: 1,
    });
    expect(g.costUsdPerRequirement).toBeCloseTo(0.2);
    // Total spend counts every run: 0.1 + 2 × 0.3.
    expect(g.totalCostUsd).toBeCloseTo(0.7);
  });

  it("has no cost when a requirement was unpriced", () => {
    const g = aggregateItems([averageRuns("A", [run({ costUsd: null })])]);
    expect(g.costUsdPerRequirement).toBeNull();
    expect(g.totalCostUsd).toBeNull();
  });
});
