import { describe, expect, it } from "vitest";
import { GAP_ARMS } from "./plan.js";
import { formatRate, predictionsOf, renderGapReport, type GapReportArm } from "./report.js";
import {
  compareArms,
  scoreArm,
  summarizeArm,
  type GapItemOutcome,
  type GapTruth,
  type RepoFileIndex,
} from "./scorer.js";

const files: RepoFileIndex = new Map([["orders", new Map([["src/a.ts", 10]])]]);
const truths: GapTruth[] = [
  { id: "FX-01", expectedRepos: ["orders"], expectedVerdict: "gap" },
  { id: "FX-02", expectedRepos: ["orders"], expectedVerdict: "implemented" },
];

const outcome = (over: Partial<GapItemOutcome>): GapItemOutcome => ({
  itemId: "FX-01",
  arm: "P0",
  run: 1,
  model: "anthropic/m",
  verdict: "gap-confirmed",
  productCoverage: "not-covered",
  criteriaCount: 1,
  repos: [
    {
      repo: "orders",
      verdict: "gap-confirmed",
      criteria: ["gap-confirmed"],
      citations: [],
      reason: null,
    },
  ],
  costUsd: 0.02,
  seconds: 3,
  ...over,
});

const outcomes: GapItemOutcome[] = [
  outcome({}),
  outcome({ run: 2, verdict: "could-not-verify" }),
  outcome({
    itemId: "FX-02",
    verdict: "implemented",
    productCoverage: "covers",
    repos: [
      {
        repo: "orders",
        verdict: "implemented",
        criteria: ["implemented"],
        citations: [{ filePath: "src/a.ts", startLine: 1, endLine: 1 }],
        reason: null,
      },
    ],
  }),
  outcome({ arm: "P0R", verdict: "partial" }),
];

function reportArm(id: string): GapReportArm {
  const arm = GAP_ARMS.find((a) => a.id === id)!;
  return {
    arm,
    model: "anthropic/m",
    configuration: { perRepoSearch: arm.perRepoSearch, hitsPerProduct: 24 },
    summary: summarizeArm(id, "anthropic/m", truths, outcomes, files),
    scored: scoreArm(id, "anthropic/m", truths, outcomes, files),
  };
}

const base = {
  corpus: "localization-02-fixture-portfolio",
  repos: [{ name: "orders", sha: "4d8bb2ba1dc3e0c06490cc6a24b3198ca616dd33" }],
  setup: "one product holding every repository",
  runsRequested: 3,
  budgetUsd: 10,
  generatedAt: "2026-11-15T00:00:00.000Z",
  items: truths,
  notRun: ["P1 (#1764): not landed yet."],
  failures: [],
};

describe("formatRate", () => {
  it("prints a value, its interval and its n, or n/a", () => {
    expect(formatRate({ value: 0.5, ci: [0.25, 0.75], n: 4 })).toBe("0.50 [0.25, 0.75] (n=4)");
    expect(formatRate(null)).toBe("n/a");
    expect(formatRate(undefined)).toBe("n/a");
  });
});

describe("predictionsOf", () => {
  it("lists one letter per run, in run order, or a dash when unscored", () => {
    const scored = scoreArm("P0", "anthropic/m", truths, [outcomes[1], outcomes[0]], files);
    expect(predictionsOf(scored, "FX-01")).toBe("G?");
    expect(predictionsOf(scored, "FX-02")).toBe("–");
  });
});

describe("renderGapReport", () => {
  it("lays out the arms, results, comparison and per-item predictions", () => {
    const p0 = reportArm("P0");
    const p0r = reportArm("P0R");
    const md = renderGapReport({
      ...base,
      arms: [p0, p0r],
      comparisons: [
        compareArms({ arm: "P0", scored: p0.scored }, { arm: "P0′", scored: p0r.scored }),
      ],
    });
    expect(md).toContain("# Portfolio gap-verdict eval — `localization-02-fixture-portfolio`");
    expect(md).toContain("`orders@4d8bb2ba`");
    expect(md).toContain("Spent: **$0.0800**");
    expect(md).toContain("### P0 · anthropic/m — shipped engine");
    expect(md).toContain("| perRepoSearch | false |");
    expect(md).toContain("- P1 (#1764): not landed yet.");
    // P0: FX-01 half right, FX-02 right → 0.75 over 2 items; one citation, valid.
    expect(md).toMatch(/\| P0 · anthropic\/m \| 0\.75 \[[0-9.]+, [0-9.]+\] \(n=2\) \|/);
    expect(md).toContain("| 0 | 1/1 | $0.0200 | 3.0 |");
    expect(md).toContain("| gap | 0 | 0 | 1 | 1 |");
    expect(md).toContain("roughly");
    expect(md).toMatch(/\| P0′ vs P0 \| -0\.50 \[/);
    expect(md).toContain("no measurable difference");
    expect(md).toContain("| FX-01 | gap | G? | P |");
    expect(md).toContain("| FX-02 | implemented | I | – |");
    expect(md).not.toContain("FAILED");
  });

  it("says when there is nothing to compare, and leads with a failure", () => {
    const md = renderGapReport({
      ...base,
      arms: [reportArm("P0")],
      comparisons: [],
      notRun: [],
      failures: ["P0 (anthropic/m): 1 uncited implemented"],
    });
    expect(md).toContain("> **FAILED.**");
    expect(md).toContain("> - P0 (anthropic/m): 1 uncited implemented");
    expect(md).toContain("No comparison: only one arm was scored.");
    expect(md).not.toContain("Not run:");
  });
});
