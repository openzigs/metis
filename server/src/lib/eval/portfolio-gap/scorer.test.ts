import { describe, expect, it } from "vitest";
import {
  citationValid,
  compareArms,
  confusionMatrix,
  gapTruths,
  outcomeFromResult,
  predictedOf,
  predictedOfCoverage,
  scoreArm,
  scoreOutcome,
  stratumOf,
  summarizeArm,
  uncitedImplemented,
  uncitedViolations,
  type GapItemOutcome,
  type GapRepoOutcome,
  type GapTruth,
  type RepoFileIndex,
} from "./scorer.js";
import type { LocalizationItem } from "../localization/corpus.js";

const files: RepoFileIndex = new Map([
  [
    "orders",
    new Map([
      ["src/routes/orders.ts", 40],
      ["src/db/orders-repo.ts", 20],
    ]),
  ],
  ["billing", new Map([["src/db/billing-repo.ts", 30]])],
]);

const cite = (filePath: string, startLine = 1, endLine = 1) => ({ filePath, startLine, endLine });

function repo(name: string, over: Partial<GapRepoOutcome> = {}): GapRepoOutcome {
  return {
    repo: name,
    verdict: "gap-confirmed",
    criteria: ["gap-confirmed"],
    citations: [],
    reason: null,
    ...over,
  };
}

function outcome(over: Partial<GapItemOutcome> = {}): GapItemOutcome {
  return {
    itemId: "FX-01",
    arm: "P0",
    run: 1,
    model: "anthropic/m",
    verdict: "gap-confirmed",
    productCoverage: "not-covered",
    criteriaCount: 1,
    repos: [repo("orders"), repo("billing")],
    costUsd: 0.01,
    seconds: 2,
    ...over,
  };
}

const implementedIn = (name: string, citations = [cite("src/routes/orders.ts")]) =>
  repo(name, { verdict: "implemented", criteria: ["implemented"], citations });

const truth = (over: Partial<GapTruth> = {}): GapTruth => ({
  id: "FX-01",
  expectedRepos: ["orders"],
  expectedVerdict: "gap",
  ...over,
});

describe("predictedOf / predictedOfCoverage", () => {
  it("names the engine's verdicts in the ground truth's words", () => {
    expect(predictedOf("gap-confirmed")).toBe("gap");
    expect(predictedOf("implemented")).toBe("implemented");
    expect(predictedOf("partial")).toBe("partial");
    expect(predictedOf("could-not-verify")).toBe("could-not-verify");
  });

  it("maps product coverage, anything unchecked reading could-not-verify", () => {
    expect(predictedOfCoverage("covers")).toBe("implemented");
    expect(predictedOfCoverage("partial")).toBe("partial");
    expect(predictedOfCoverage("not-covered")).toBe("gap");
    expect(predictedOfCoverage("not-checked")).toBe("could-not-verify");
    expect(predictedOfCoverage("restricted")).toBe("could-not-verify");
    expect(predictedOfCoverage(null)).toBe("could-not-verify");
  });
});

describe("outcomeFromResult", () => {
  it("renames repos by connector id, keeps an unknown repo's label, and copies only the span", () => {
    const o = outcomeFromResult(
      {
        verdict: "partial",
        criteria: ["a", "b"],
        products: [
          {
            coverage: "partial",
            repos: [
              {
                repoConnectionId: "rc-orders",
                label: "openzigs/orders",
                verdict: "partial",
                criteria: ["implemented", "gap-confirmed"],
                citations: [
                  { filePath: "src/x.ts", startLine: 1, endLine: 1, snippet: "x" } as never,
                ],
                reason: null,
              },
              {
                repoConnectionId: "rc-stray",
                label: "openzigs/stray",
                verdict: "could-not-verify",
                criteria: ["could-not-verify", "could-not-verify"],
                citations: [],
                reason: "no-evidence-retrieved",
              },
            ],
          },
        ],
      },
      { itemId: "FX-02", arm: "P0R", run: 2, model: "m", costUsd: 0.5, seconds: 3 },
      new Map([["rc-orders", "orders"]]),
    );
    expect(o).toEqual({
      itemId: "FX-02",
      arm: "P0R",
      run: 2,
      model: "m",
      costUsd: 0.5,
      seconds: 3,
      verdict: "partial",
      productCoverage: "partial",
      criteriaCount: 2,
      repos: [
        {
          repo: "orders",
          verdict: "partial",
          criteria: ["implemented", "gap-confirmed"],
          citations: [{ filePath: "src/x.ts", startLine: 1, endLine: 1 }],
          reason: null,
        },
        {
          repo: "openzigs/stray",
          verdict: "could-not-verify",
          criteria: ["could-not-verify", "could-not-verify"],
          citations: [],
          reason: "no-evidence-retrieved",
        },
      ],
    });
  });

  it("reads a result with no product as no coverage", () => {
    const o = outcomeFromResult(
      { verdict: "could-not-verify", criteria: [], products: [] },
      { itemId: "FX-01", arm: "P0", run: 1, model: "m", costUsd: 0, seconds: 0 },
      new Map(),
    );
    expect(o.productCoverage).toBeNull();
    expect(o.repos).toEqual([]);
  });
});

describe("citationValid", () => {
  it("needs the file in that repo and lines inside it", () => {
    expect(citationValid("orders", cite("src/routes/orders.ts", 1, 40), files)).toBe(true);
    expect(citationValid("orders", cite("src/routes/orders.ts", 1, 41), files)).toBe(false);
    expect(citationValid("orders", cite("src/routes/orders.ts", 0, 1), files)).toBe(false);
    expect(citationValid("orders", cite("src/routes/orders.ts", 5, 4), files)).toBe(false);
    // The file exists, but in another repository.
    expect(citationValid("billing", cite("src/routes/orders.ts"), files)).toBe(false);
    expect(citationValid("notify", cite("src/routes/orders.ts"), files)).toBe(false);
  });
});

describe("uncitedImplemented", () => {
  it("is 0 when every implemented repo cites", () => {
    expect(
      uncitedImplemented(outcome({ verdict: "implemented", repos: [implementedIn("orders")] })),
    ).toBe(0);
  });

  it("counts each implemented repo with no citation", () => {
    const o = outcome({
      verdict: "implemented",
      repos: [implementedIn("orders", []), implementedIn("billing", []), repo("notify")],
    });
    // Two repos uncited, and the portfolio claims coverage with no citation at all.
    expect(uncitedImplemented(o)).toBe(3);
  });

  it("counts a covered portfolio verdict no citation backs", () => {
    expect(uncitedImplemented(outcome({ verdict: "partial", repos: [repo("orders")] }))).toBe(1);
    expect(uncitedImplemented(outcome({ verdict: "implemented", repos: [] }))).toBe(1);
  });

  it("does not count a gap or could-not-verify with no citation", () => {
    expect(uncitedImplemented(outcome({ verdict: "gap-confirmed" }))).toBe(0);
    expect(uncitedImplemented(outcome({ verdict: "could-not-verify" }))).toBe(0);
  });
});

describe("scoreOutcome", () => {
  it("scores a correct gap, with no recall for a gap answer", () => {
    const s = scoreOutcome(truth(), outcome(), files);
    expect(s).toMatchObject({
      expected: "gap",
      predicted: "gap",
      correct: true,
      productPredicted: "gap",
      answerRepoPredicted: "gap",
      uncited: 0,
      citations: 0,
      validCitations: 0,
      expectedRepoRecall: null,
      costUsd: 0.01,
      seconds: 2,
    });
  });

  it("scores a wrong verdict, counts valid and invalid citations", () => {
    const s = scoreOutcome(
      truth({ expectedVerdict: "partial" }),
      outcome({
        verdict: "implemented",
        productCoverage: "covers",
        repos: [
          implementedIn("orders", [cite("src/routes/orders.ts"), cite("src/missing.ts")]),
          repo("billing"),
        ],
      }),
      files,
    );
    expect(s.correct).toBe(false);
    expect(s.predicted).toBe("implemented");
    expect(s.productPredicted).toBe("implemented");
    expect(s.answerRepoPredicted).toBe("implemented");
    expect(s.citations).toBe(2);
    expect(s.validCitations).toBe(1);
    expect(s.expectedRepoRecall).toBe(1);
  });

  it("reads a missing answer repo as could-not-verify, and recall over the answer repos", () => {
    const s = scoreOutcome(
      truth({ expectedVerdict: "implemented" }),
      outcome({
        verdict: "implemented",
        repos: [implementedIn("billing", [cite("src/db/billing-repo.ts")])],
      }),
      files,
    );
    expect(s.answerRepoPredicted).toBe("could-not-verify");
    expect(s.expectedRepoRecall).toBe(0);
  });

  it("has no answer-repo verdict for a multi-repo answer, and recall is a share", () => {
    const s = scoreOutcome(
      truth({ expectedRepos: ["orders", "billing", "orders"], expectedVerdict: "partial" }),
      outcome({ verdict: "partial", repos: [implementedIn("orders"), repo("billing")] }),
      files,
    );
    expect(s.answerRepoPredicted).toBeNull();
    expect(s.expectedRepoRecall).toBe(0.5);
  });

  it("has no recall when nothing is expected", () => {
    const s = scoreOutcome(
      truth({ expectedRepos: [], expectedVerdict: "implemented" }),
      outcome(),
      files,
    );
    expect(s.expectedRepoRecall).toBeNull();
  });

  it("refuses to score one item against another's truth", () => {
    expect(() => scoreOutcome(truth({ id: "FX-02" }), outcome(), files)).toThrow(/FX-01.*FX-02/);
  });
});

describe("confusionMatrix", () => {
  it("counts expected rows by predicted columns", () => {
    const truths = [truth(), truth({ id: "FX-02", expectedVerdict: "implemented" })];
    const scored = scoreArm(
      "P0",
      "anthropic/m",
      truths,
      [
        outcome(),
        outcome({ run: 2, verdict: "could-not-verify" }),
        outcome({ itemId: "FX-02", verdict: "partial", repos: [implementedIn("orders")] }),
      ],
      files,
    );
    const m = confusionMatrix(scored);
    expect(m.gap).toEqual({ implemented: 0, partial: 0, gap: 1, "could-not-verify": 1 });
    expect(m.implemented).toEqual({ implemented: 0, partial: 1, gap: 0, "could-not-verify": 0 });
    expect(m.partial).toEqual({ implemented: 0, partial: 0, gap: 0, "could-not-verify": 0 });
  });
});

describe("stratumOf", () => {
  it("is the one answer repo, or multi-repo", () => {
    expect(stratumOf({ expectedRepos: ["orders", "orders"] })).toBe("orders");
    expect(stratumOf({ expectedRepos: ["orders", "billing"] })).toBe("multi-repo");
  });
});

describe("summarizeArm", () => {
  const truths: GapTruth[] = [
    truth(),
    truth({ id: "FX-02", expectedRepos: ["billing"], expectedVerdict: "implemented" }),
  ];
  const outcomes: GapItemOutcome[] = [
    // FX-01 right in run 1, wrong in run 2: item accuracy 0.5.
    outcome({ costUsd: 0.02, seconds: 4 }),
    outcome({
      run: 2,
      verdict: "could-not-verify",
      productCoverage: "not-checked",
      costUsd: 0.04,
      seconds: 6,
    }),
    // FX-02 right in run 1 only (run 2 missing): item accuracy 1.
    outcome({
      itemId: "FX-02",
      verdict: "implemented",
      productCoverage: "covers",
      repos: [implementedIn("billing", [cite("src/db/billing-repo.ts")])],
      costUsd: 0.06,
      seconds: 8,
    }),
    // Another arm and another model are not this arm's.
    outcome({ arm: "P0R", verdict: "partial" }),
    outcome({ model: "other/m", verdict: "partial" }),
  ];

  it("averages each item's runs, then the items", () => {
    const s = summarizeArm("P0", "anthropic/m", truths, outcomes, files);
    expect(s.outcomes).toBe(3);
    expect(s.completeRuns).toBe(1);
    expect(s.accuracy?.value).toBeCloseTo(0.75);
    expect(s.accuracy?.n).toBe(2);
    expect(s.accuracy?.ci[0]).toBeLessThanOrEqual(0.75);
    expect(s.accuracy?.ci[1]).toBeGreaterThanOrEqual(0.75);
    expect(s.productAccuracy?.value).toBeCloseTo(0.75);
    expect(s.answerRepoAccuracy?.value).toBeCloseTo(1);
    expect(s.accuracyByStratum.orders.value).toBeCloseTo(0.5);
    expect(s.accuracyByStratum.billing.value).toBeCloseTo(1);
    expect(s.accuracyByExpected.gap?.value).toBeCloseTo(0.5);
    expect(s.accuracyByExpected.implemented?.value).toBeCloseTo(1);
    expect(s.accuracyByExpected.partial).toBeUndefined();
    expect(s.confusion.gap.gap).toBe(1);
    expect(s.uncitedImplemented).toBe(0);
    expect(s.citations).toBe(1);
    expect(s.validCitations).toBe(1);
    expect(s.expectedRepoRecall?.value).toBe(1);
    expect(s.spentUsd).toBeCloseTo(0.12);
    expect(s.usdPerRequirement).toBeCloseTo(0.04);
    expect(s.secondsPerRequirement).toBeCloseTo(6);
  });

  it("is empty for an arm with no outcomes", () => {
    const s = summarizeArm("P1", "anthropic/m", truths, outcomes, files);
    expect(s.outcomes).toBe(0);
    expect(s.accuracy).toBeNull();
    expect(s.usdPerRequirement).toBe(0);
    expect(s.secondsPerRequirement).toBe(0);
  });

  it("throws on an outcome naming an item with no ground truth", () => {
    expect(() =>
      summarizeArm("P0", "anthropic/m", truths, [outcome({ itemId: "FX-99" })], files),
    ).toThrow(/FX-99/);
  });
});

describe("uncitedViolations", () => {
  it("names every arm with an uncited implemented claim", () => {
    const truths = [truth({ expectedVerdict: "implemented" })];
    const clean = summarizeArm(
      "P0",
      "m",
      truths,
      [outcome({ model: "m", verdict: "gap-confirmed" })],
      files,
    );
    const dirty = summarizeArm(
      "P0R",
      "m",
      truths,
      [
        outcome({
          arm: "P0R",
          model: "m",
          verdict: "implemented",
          repos: [implementedIn("orders", [])],
        }),
      ],
      files,
    );
    expect(uncitedViolations([clean])).toEqual([]);
    expect(uncitedViolations([clean, dirty])).toEqual(["P0R (m): 2 uncited implemented"]);
  });
});

describe("compareArms", () => {
  const truths: GapTruth[] = ["FX-01", "FX-02", "FX-03", "FX-04"].map((id) => truth({ id }));
  const right = (itemId: string, run = 1, arm = "P0") => outcome({ itemId, run, arm });
  const wrong = (itemId: string, run = 1, arm = "P0") =>
    outcome({ itemId, run, arm, verdict: "could-not-verify" });

  it("pairs items, reads majority correctness for McNemar, and is unmeasurable at this size", () => {
    const base = scoreArm(
      "P0",
      "anthropic/m",
      truths,
      [wrong("FX-01"), wrong("FX-02"), right("FX-03"), right("FX-04"), wrong("FX-04", 2)],
      files,
    );
    const arm = scoreArm(
      "P0R",
      "anthropic/m",
      truths,
      // FX-04 only in the baseline: unpaired items are left out.
      [right("FX-01", 1, "P0R"), right("FX-02", 1, "P0R"), wrong("FX-03", 1, "P0R")],
      files,
    );
    const c = compareArms({ arm: "P0", scored: base }, { arm: "P0′", scored: arm });
    expect(c.arm).toBe("P0′");
    expect(c.baseline).toBe("P0");
    expect(c.accuracy.n).toBe(3);
    expect(c.accuracy.meanDifference).toBeCloseTo(1 / 3);
    expect(c.mcnemar).toEqual({ armOnly: 2, baselineOnly: 1, p: 1 });
    expect(c.reading).toBe("no measurable difference");
  });

  it("does not count a half-right item (1 of 2 runs) as a majority hit", () => {
    const base = scoreArm("P0", "anthropic/m", truths, [right("FX-01"), wrong("FX-01", 2)], files);
    const arm = scoreArm("P0R", "anthropic/m", truths, [right("FX-01", 1, "P0R")], files);
    const c = compareArms({ arm: "P0", scored: base }, { arm: "P0R", scored: arm });
    expect(c.mcnemar.armOnly).toBe(1);
    expect(c.mcnemar.baselineOnly).toBe(0);
    // And the other way round: a half-right arm item is no hit over a wrong baseline.
    const halfArm = scoreArm(
      "P0R",
      "anthropic/m",
      truths,
      [right("FX-01", 1, "P0R"), wrong("FX-01", 2, "P0R")],
      files,
    );
    const wrongBase = scoreArm("P0", "anthropic/m", truths, [wrong("FX-01")], files);
    const d = compareArms({ arm: "P0", scored: wrongBase }, { arm: "P0R", scored: halfArm });
    expect(d.mcnemar).toEqual({ armOnly: 0, baselineOnly: 0, p: 1 });
  });
});

describe("gapTruths", () => {
  const item = (over: Partial<LocalizationItem>): LocalizationItem => ({
    id: "FX-01",
    title: "t",
    text: "x",
    expectedFiles: [],
    expectedRepos: ["orders"],
    source: { kind: "authored" },
    ...over,
  });

  it("keeps each item's id, repos and verdict", () => {
    expect(gapTruths([item({ expectedVerdict: "partial" })])).toEqual([
      { id: "FX-01", expectedRepos: ["orders"], expectedVerdict: "partial" },
    ]);
  });

  it("throws for an item with no verdict", () => {
    expect(() => gapTruths([item({})])).toThrow(/FX-01 has no expected verdict/);
  });
});
