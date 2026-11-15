import { describe, expect, it } from "vitest";
import {
  budgetStop,
  GAP_ARMS,
  parseGapArms,
  parsePositiveInt,
  parseRecordFile,
  parseRecords,
  pendingWork,
  recordedSpendUsd,
  recordLine,
  type GapSpendRecord,
} from "./plan.js";
import type { GapItemOutcome } from "./scorer.js";

const outcome = (over: Partial<GapItemOutcome> = {}): GapItemOutcome => ({
  itemId: "FX-01",
  arm: "P0",
  run: 1,
  model: "anthropic/m",
  verdict: "gap-confirmed",
  productCoverage: "not-covered",
  criteriaCount: 1,
  repos: [],
  costUsd: 0.01,
  seconds: 1,
  ...over,
});

describe("GAP_ARMS", () => {
  it("P0 is the shipped engine and P0R turns on #1763's per-repo search, nothing else", () => {
    expect(GAP_ARMS.map((a) => [a.id, a.perRepoSearch])).toEqual([
      ["P0", false],
      ["P0R", true],
    ]);
  });
});

describe("parseGapArms", () => {
  it("defaults to every arm", () => {
    expect(parseGapArms(undefined).map((a) => a.id)).toEqual(["P0", "P0R"]);
  });

  it("keeps the order given, case-insensitive, once each", () => {
    expect(parseGapArms(" p0r ,P0,P0R").map((a) => a.id)).toEqual(["P0R", "P0"]);
  });

  it("refuses an unknown arm and an empty list", () => {
    expect(() => parseGapArms("P0,P1")).toThrow(/unknown arm P1/);
    expect(() => parseGapArms(" , ")).toThrow(/names no arm/);
  });
});

describe("parsePositiveInt", () => {
  it("reads a positive whole number, or the fallback when absent", () => {
    expect(parsePositiveInt("3", "--runs", 1)).toBe(3);
    expect(parsePositiveInt(undefined, "--runs", 7)).toBe(7);
  });

  it("refuses zero, fractions and words", () => {
    for (const bad of ["0", "-1", "1.5", "two", ""]) {
      expect(() => parsePositiveInt(bad, "--runs", 1)).toThrow(
        /--runs must be a positive whole number/,
      );
    }
  });
});

describe("pendingWork", () => {
  it("runs every arm's run 1 before any run 2, skipping what this model recorded", () => {
    const work = pendingWork({
      itemIds: ["FX-01", "FX-02"],
      arms: ["P0", "P0R"],
      runs: 2,
      model: "anthropic/m",
      done: [
        outcome(),
        // Recorded for another model: still to run on this one.
        outcome({ itemId: "FX-02", model: "deepseek/flash" }),
        outcome({ arm: "P0R", run: 2, itemId: "FX-02" }),
      ],
    });
    expect(work).toEqual([
      { arm: "P0", run: 1, itemId: "FX-02" },
      { arm: "P0R", run: 1, itemId: "FX-01" },
      { arm: "P0R", run: 1, itemId: "FX-02" },
      { arm: "P0", run: 2, itemId: "FX-01" },
      { arm: "P0", run: 2, itemId: "FX-02" },
      { arm: "P0R", run: 2, itemId: "FX-01" },
    ]);
  });

  it("is empty once everything is recorded", () => {
    expect(
      pendingWork({
        itemIds: ["FX-01"],
        arms: ["P0"],
        runs: 1,
        model: "anthropic/m",
        done: [outcome()],
      }),
    ).toEqual([]);
  });
});

describe("parseRecords / recordLine", () => {
  it("round-trips outcomes and skips blank lines", () => {
    const a = outcome();
    const b = outcome({ itemId: "FX-02", run: 2 });
    expect(parseRecords(`${recordLine(a)}\n${recordLine(b)}`)).toEqual([a, b]);
    expect(recordLine(a).endsWith("\n")).toBe(true);
    expect(parseRecords("")).toEqual([]);
  });

  it("names a line that is not JSON", () => {
    expect(() => parseRecords(`${recordLine(outcome())}{oops\n`)).toThrow(/line 2 is not JSON/);
  });

  it("names a line that is not an outcome", () => {
    const { costUsd: _drop, ...noCost } = outcome();
    for (const bad of [noCost, { ...outcome(), run: 1.5 }, { ...outcome(), repos: null }, null]) {
      expect(() => parseRecords(`${JSON.stringify(bad)}\n`)).toThrow(/line 1 is not an outcome/);
    }
  });
});

describe("spend records", () => {
  const spend = (over: Partial<GapSpendRecord> = {}): GapSpendRecord => ({
    kind: "spend",
    itemId: "FX-03",
    arm: "P0",
    run: 1,
    model: "anthropic/m",
    costUsd: 0.25,
    reason: "unpriced call",
    ...over,
  });

  it("keeps an item's priced spend apart from the outcomes, so the item stays pending", () => {
    const text = `${recordLine(outcome())}${recordLine(spend())}`;
    const file = parseRecordFile(text);
    expect(file.outcomes).toEqual([outcome()]);
    expect(file.spends).toEqual([spend()]);
    expect(parseRecords(text)).toEqual([outcome()]);
    expect(
      pendingWork({
        itemIds: ["FX-01", "FX-03"],
        arms: ["P0"],
        runs: 1,
        model: "anthropic/m",
        done: file.outcomes,
      }),
    ).toEqual([{ arm: "P0", run: 1, itemId: "FX-03" }]);
  });

  it("counts spend records toward the model's recorded spend, and no other model's", () => {
    const file = parseRecordFile(
      [
        recordLine(outcome({ costUsd: 0.5 })),
        recordLine(spend({ costUsd: 0.25 })),
        recordLine(spend({ model: "other/m", costUsd: 9 })),
        recordLine(outcome({ model: "other/m", costUsd: 9 })),
      ].join(""),
    );
    expect(recordedSpendUsd(file, "anthropic/m")).toBeCloseTo(0.75);
    expect(recordedSpendUsd({ outcomes: [], spends: [] }, "anthropic/m")).toBe(0);
  });

  it("names a malformed spend record", () => {
    const { reason: _drop, ...noReason } = spend();
    for (const bad of [noReason, { ...spend(), costUsd: "1" }, { ...spend(), run: 0.5 }]) {
      expect(() => parseRecordFile(`${JSON.stringify(bad)}\n`)).toThrow(
        /line 1 is not a spend record/,
      );
    }
  });
});

describe("budgetStop", () => {
  const ok = { spentUsd: 1, costliestItemUsd: 0.5, budgetUsd: 2, unpricedCalls: 0 };

  it("lets an item start while the costliest one so far still fits", () => {
    expect(budgetStop(ok)).toBeNull();
    expect(budgetStop({ ...ok, costliestItemUsd: 1 })).toBeNull();
  });

  it("stops at the cap, before an item that would cross it, and on an unpriced call", () => {
    expect(budgetStop({ ...ok, spentUsd: 2 })).toMatch(/spent \$2\.0000 of the \$2 cap/);
    expect(budgetStop({ ...ok, costliestItemUsd: 1.01 })).toMatch(
      /would carry \$1\.0000 past the \$2 cap/,
    );
    expect(budgetStop({ ...ok, unpricedCalls: 1 })).toMatch(/no ledger price/);
  });
});
