/**
 * #137 — the usage a successful chat turn is metered on: what the provider
 * reported, or a documented estimate only when it reported nothing.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../prisma.js", () => ({ prisma: {} }));
const { billableTurnUsage, isReportedUsage } = await import("./turn-usage.js");

const ratio = { charsPerToken: 3, source: "calibrated" as const, samples: 1 };

describe("isReportedUsage", () => {
  it("is true when any count is non-zero, false for none or all-zero", () => {
    expect(isReportedUsage(null)).toBe(false);
    expect(isReportedUsage(undefined)).toBe(false);
    expect(isReportedUsage({ promptTokens: 0, completionTokens: 0, totalTokens: 0 })).toBe(false);
    expect(isReportedUsage({ promptTokens: 0, completionTokens: 2, totalTokens: 0 })).toBe(true);
    expect(isReportedUsage({ promptTokens: 0, completionTokens: 0, totalTokens: 5 })).toBe(true);
    expect(isReportedUsage({ promptTokens: 9, completionTokens: 0, totalTokens: 0 })).toBe(true);
  });
});

describe("billableTurnUsage", () => {
  it("passes reported usage through untouched, cache counts included", () => {
    const reported = {
      promptTokens: 120,
      completionTokens: 7,
      totalTokens: 127,
      cacheReadTokens: 100,
      cacheWriteTokens: 5,
    };
    const billed = billableTurnUsage(reported, { promptTokens: 999, answerText: "x", ratio });
    expect(billed).toEqual({ usage: reported, estimated: false });
  });

  it("estimates only when nothing was reported: prompt estimate in, reply chars out, no cache", () => {
    for (const none of [null, { promptTokens: 0, completionTokens: 0, totalTokens: 0 }]) {
      expect(billableTurnUsage(none, { promptTokens: 41.6, answerText: "abcdefg", ratio })).toEqual(
        {
          usage: {
            promptTokens: 42,
            completionTokens: 3,
            totalTokens: 45,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
          estimated: true,
        },
      );
    }
  });
});
