import { describe, expect, it } from "vitest";
import {
  assertReferenceArms,
  assertReferenceArmsInEachCorpus,
  flagValue,
  nonNegativeNumber,
  positiveInteger,
  referenceArmIds,
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

describe("assertReferenceArms (#1819)", () => {
  it("accepts references among the run's arms", () => {
    expect(() => assertReferenceArms([], ["A0"])).not.toThrow();
    expect(() => assertReferenceArms(["A12", "A13"], ["A0", "A12", "A13"])).not.toThrow();
  });

  it("refuses a reference the run does not report, naming the arms", () => {
    expect(() => assertReferenceArms(["A12", "A31"], ["A0", "A12", "A13"])).toThrow(
      "--reference A31 is not one of this run's arms (A0, A12, A13)",
    );
    expect(() => assertReferenceArms(["A0"], ["A0", "A12"])).toThrow(/--reference A0/);
  });
});

describe("assertReferenceArmsInEachCorpus (#1925)", () => {
  it("refuses a reference one corpus did not record, though the union of arms holds it", () => {
    const recorded = new Map([
      ["localization-01-miniflux-heldout", ["A0", "A7", "A7S"]],
      ["localization-02-fixture-portfolio", ["A0", "A7"]],
    ]);
    expect(() => assertReferenceArmsInEachCorpus(["A7"], recorded)).not.toThrow();
    expect(() => assertReferenceArmsInEachCorpus(["A7", "A7S"], recorded)).toThrow(
      "--reference A7S is not one of the arms localization-02-fixture-portfolio recorded (A0, A7)",
    );
    expect(() => assertReferenceArmsInEachCorpus(["A0"], recorded)).toThrow(/--reference A0/);
    expect(() => assertReferenceArmsInEachCorpus([], new Map())).not.toThrow();
  });
});
