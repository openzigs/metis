import { describe, expect, it } from "vitest";
import { parseCodePassLiveArgs, selectLiveItems } from "./code-pass-live-args.js";

describe("parseCodePassLiveArgs (#2568)", () => {
  it("defaults to five requirements, every fifth item, a $1.50 budget", () => {
    expect(parseCodePassLiveArgs(["--mode", "fast"])).toEqual({
      mode: "fast",
      budgetUsd: 1.5,
      requirements: 5,
      items: 5,
    });
    expect(
      parseCodePassLiveArgs(["--mode", "explore", "--requirements", "2", "--items", "1"]),
    ).toMatchObject({ mode: "explore", requirements: 2, items: 1 });
  });

  it("refuses a missing mode and a non-positive budget", () => {
    expect(() => parseCodePassLiveArgs([])).toThrow(/--mode/);
    expect(() => parseCodePassLiveArgs(["--mode", "fast", "--budget", "0"])).toThrow(/--budget/);
  });

  it.each(["0", "-1", "x", "1.5", "", "1e2"])("refuses --requirements and --items of %j", (bad) => {
    expect(() => parseCodePassLiveArgs(["--mode", "fast", "--requirements", bad])).toThrow(
      /--requirements must be a positive integer/,
    );
    expect(() => parseCodePassLiveArgs(["--mode", "fast", "--items", bad])).toThrow(
      /--items must be a positive integer/,
    );
  });

  it("refuses a flag given with no value", () => {
    expect(() => parseCodePassLiveArgs(["--mode", "fast", "--items"])).toThrow(/--items/);
  });
});

describe("selectLiveItems (#2568)", () => {
  const all = ["a", "b", "c", "d", "e", "f", "g"];

  it("takes every n-th item, at most the requirement count", () => {
    expect(selectLiveItems(all, { items: 3, requirements: 5 })).toEqual(["a", "d", "g"]);
    expect(selectLiveItems(all, { items: 1, requirements: 2 })).toEqual(["a", "b"]);
  });

  it("refuses an empty selection before any model call", () => {
    expect(() => selectLiveItems([], { items: 1, requirements: 5 })).toThrow(/no held-out items/);
  });
});
