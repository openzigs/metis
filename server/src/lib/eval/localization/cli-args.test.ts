import { describe, expect, it } from "vitest";
import { PATCH_ARM_IDS, STALENESS_ARM_IDS } from "./analysis-arms.js";
import {
  flagValue,
  nonNegativeNumber,
  positiveInteger,
  referenceArmIds,
  stalenessPreflight,
} from "./cli-args.js";

describe("flagValue", () => {
  it("reads the value after a flag, and nothing for an absent flag", () => {
    expect(flagValue(["--runs", "2"], "runs")).toBe("2");
    expect(flagValue(["--md"], "runs")).toBeUndefined();
    expect(flagValue([], "runs")).toBeUndefined();
  });

  it("refuses a bare flag instead of falling back to the default (#1779)", () => {
    expect(() => flagValue(["--runs", "--md"], "runs")).toThrow(/^--runs needs a value$/);
    expect(() => flagValue(["--md", "--budget"], "budget")).toThrow(/^--budget needs a value$/);
  });
});

describe("positiveInteger (#1770)", () => {
  it("takes a whole number of at least 1, or the fallback when absent", () => {
    expect(positiveInteger("2", 3, "runs")).toBe(2);
    expect(positiveInteger(undefined, 3, "runs")).toBe(3);
  });

  it.each(["0", "-1", "1.5", "two", "", " "])("refuses %j instead of coercing it", (raw) => {
    expect(() => positiveInteger(raw, 3, "runs")).toThrow(
      /^--runs must be a whole number of at least 1/,
    );
  });
});

describe("nonNegativeNumber", () => {
  it("takes zero and fractions, or the fallback when absent", () => {
    expect(nonNegativeNumber("0", 35, "budget")).toBe(0);
    expect(nonNegativeNumber("2.5", 35, "budget")).toBe(2.5);
    expect(nonNegativeNumber(undefined, 35, "budget")).toBe(35);
  });

  it.each(["-0.01", "lots", "Infinity", ""])("refuses %j", (raw) => {
    expect(() => nonNegativeNumber(raw, 35, "budget")).toThrow(/^--budget must be a non-negative/);
  });
});

describe("referenceArmIds (#1806)", () => {
  it("reads a comma list, upper-cased and deduplicated; none when absent", () => {
    expect(referenceArmIds(["--reference", "a12, A13,a12"])).toEqual(["A12", "A13"]);
    expect(referenceArmIds(["--md"])).toEqual([]);
  });

  it("refuses A0, which every report already compares against, and an empty list", () => {
    expect(() => referenceArmIds(["--reference", "A12,a0"])).toThrow(
      /^--reference A0: every arm is already compared with A0/,
    );
    expect(() => referenceArmIds(["--reference", " , "])).toThrow(/^--reference needs an arm/);
  });
});

describe("stalenessPreflight (#1933)", () => {
  const corpora = ["localization-01-miniflux-heldout", "localization-02-fixture-portfolio"];
  const plan = (
    reportedArmIds: string[],
    o: { merge?: boolean; tableGuard?: boolean; armsRequested?: boolean } = {},
  ) =>
    stalenessPreflight({
      reportedArmIds,
      corpora,
      merge: o.merge ?? false,
      tableGuard: o.tableGuard ?? false,
      armsRequested: o.armsRequested ?? false,
      stalenessArmIds: STALENESS_ARM_IDS,
      patchArmIds: PATCH_ARM_IDS,
    });

  it("checks nothing when no staleness arm is reported", () => {
    expect(plan(["A0", "A7", "A7K"])).toBeUndefined();
    expect(plan(["A0", "A7"], { tableGuard: true })).toBeUndefined();
  });

  it("needs no patch set for a re-ingest-only run (A7R, A7RD), with or without --table-guard", () => {
    expect(plan(["A0", "A7R", "A7RD"])).toEqual({ corpora, withGuard: false, patches: false });
    expect(plan(["A0", "A7R"], { tableGuard: true })).toEqual({
      corpora,
      withGuard: false,
      patches: false,
    });
  });

  it("needs the patch sets for a patch arm, and the table corpus's only with --table-guard", () => {
    expect(plan(["A0", "A7R", "A7S"])).toEqual({ corpora, withGuard: false, patches: true });
    expect(plan(["A0", "A7SD"], { tableGuard: true })).toEqual({
      corpora,
      withGuard: true,
      patches: true,
    });
  });

  it("a merge checks no corpus of its own: only the table guard's patches, when it reads one", () => {
    expect(plan(["A0", "A7S"], { merge: true })).toBeUndefined();
    expect(plan(["A0", "A7R"], { merge: true, tableGuard: true })).toBeUndefined();
    expect(plan(["A0", "A7S"], { merge: true, tableGuard: true, armsRequested: true })).toEqual({
      corpora: [],
      withGuard: true,
      patches: true,
    });
  });

  it("refuses a merge's --table-guard over a patch arm without --arms, naming the recorded arms", () => {
    expect(() => plan(["A0", "A7R", "A7S"], { merge: true, tableGuard: true })).toThrow(
      "--table-guard reads A7S on the materialized table corpus: pass --arms A0,A7R,A7S (the recorded arms) so the eval database is bound",
    );
    // A run (not a merge) binds the database from its own --arms.
    expect(() => plan(["A0", "A7S"], { tableGuard: true })).not.toThrow();
  });
});
