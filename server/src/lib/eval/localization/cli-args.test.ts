import { describe, expect, it } from "vitest";
import { flagValue, nonNegativeNumber, positiveInteger, referenceArmIds } from "./cli-args.js";

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
