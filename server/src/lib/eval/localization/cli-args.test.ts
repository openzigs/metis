import { describe, expect, it } from "vitest";
import { flagValue, nonNegativeNumber, positiveInteger } from "./cli-args.js";

describe("flagValue", () => {
  it("reads the value after a flag, and nothing for a bare or absent flag", () => {
    expect(flagValue(["--runs", "2"], "runs")).toBe("2");
    expect(flagValue(["--runs", "--md"], "runs")).toBeUndefined();
    expect(flagValue(["--runs"], "runs")).toBeUndefined();
    expect(flagValue([], "runs")).toBeUndefined();
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
