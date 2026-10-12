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

  it("counts a report of cache tokens alone as reported (#293 review)", () => {
    const zero = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    expect(isReportedUsage({ ...zero, cacheReadTokens: 4 })).toBe(true);
    expect(isReportedUsage({ ...zero, cacheWriteTokens: 4 })).toBe(true);
    expect(isReportedUsage({ ...zero, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBe(false);
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

// #1080 (PR #1092 review) — a turn is recorded as ONE row holding the sum of its
// model calls; a model priced by prompt length bills each call in one tier, so
// the meter keeps each call's own usage for the recorders.
describe("TurnUsageMeter.requests", () => {
  const scope = {
    sessionId: "s-1",
    userId: "u-1",
    projectId: null,
    provider: "anthropic" as const,
    model: "claude-haiku-5-5",
  };
  const call = (promptTokens: number, completionTokens: number) => ({
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  });

  it("keeps each call in order beside the running sum", async () => {
    const { TurnUsageMeter } = await import("./turn-usage.js");
    const meter = new TurnUsageMeter(scope);
    expect(meter.requests).toEqual([]);

    meter.add(call(30_000, 1_000));
    meter.add(call(120_000, 500));

    expect(meter.requests).toEqual([call(30_000, 1_000), call(120_000, 500)]);
    expect(meter.usage).toMatchObject({ promptTokens: 150_000, completionTokens: 1_500 });
  });

  it("copies what it is given, so a caller reusing its usage object cannot rewrite a call", async () => {
    const { TurnUsageMeter } = await import("./turn-usage.js");
    const meter = new TurnUsageMeter(scope);
    const reused = call(10, 1);
    meter.add(reused);
    reused.promptTokens = 999;
    expect(meter.requests[0]!.promptTokens).toBe(10);
  });

  it("a single-call turn's `set` is one request, replacing anything added before", async () => {
    const { TurnUsageMeter } = await import("./turn-usage.js");
    const meter = new TurnUsageMeter(scope);
    meter.add(call(5, 5));
    meter.set(call(40, 9));
    expect(meter.requests).toEqual([call(40, 9)]);
    expect(meter.usage).toEqual(call(40, 9));
  });
});
