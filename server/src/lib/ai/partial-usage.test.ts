/** #1238 — the usage a provider reported before a call failed, carried on its error. */
import { describe, expect, it } from "vitest";
import { attachPartialUsage, partialUsageOf } from "./partial-usage.js";

const USAGE = { promptTokens: 10, completionTokens: 1, totalTokens: 11 };

describe("partial usage on an error", () => {
  it("reads back what was attached, as a copy", () => {
    const err = attachPartialUsage(new Error("terminated"), USAGE);
    const read = partialUsageOf(err);
    expect(read).toEqual(USAGE);
    read!.promptTokens = 999;
    expect(partialUsageOf(err)).toEqual(USAGE);
  });

  it("follows `cause` when a caller wraps the adapter's error", () => {
    const inner = attachPartialUsage(new Error("terminated"), USAGE);
    expect(partialUsageOf(new Error("outer", { cause: inner }))).toEqual(USAGE);
  });

  it("is never serialised with the error", () => {
    const err = attachPartialUsage(new Error("terminated"), USAGE);
    expect(JSON.stringify(err)).not.toContain("promptTokens");
    expect(Object.keys(err)).toEqual([]);
  });

  it("reports nothing for an error without it, or for a non-object", () => {
    expect(partialUsageOf(new Error("x"))).toBeUndefined();
    expect(partialUsageOf("terminated")).toBeUndefined();
    expect(partialUsageOf(null)).toBeUndefined();
    expect(attachPartialUsage("s", USAGE)).toBe("s");
  });
});
