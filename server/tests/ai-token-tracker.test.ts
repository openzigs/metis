/**
 * Tests for the AI token tracker — sanitisation, in-memory aggregation,
 * persistence, and daily rollup.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  dayBucket: string;
  userId: string;
}
const rows: Row[] = [];
vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    aITokenUsage: {
      create: vi.fn(async ({ data }: { data: Row }) => {
        rows.push(data);
        return data;
      }),
      findMany: vi.fn(async ({ where }: { where: { userId: string; dayBucket?: string } }) =>
        rows.filter(
          (r) => r.userId === where.userId && (!where.dayBucket || r.dayBucket === where.dayBucket),
        ),
      ),
    },
  },
}));

import {
  TokenTracker,
  hashPrompt,
  __resetTokenTrackerSingleton,
  getTokenTracker,
} from "../src/lib/ai/token-tracker.js";

beforeEach(() => {
  rows.length = 0;
  __resetTokenTrackerSingleton();
});

describe("TokenTracker.record", () => {
  it("aggregates per-session and totals add up", () => {
    const t = new TokenTracker();
    t.record({
      sessionId: "s1",
      userId: "u1",
      provider: "offline-stub",
      model: "stub",
      usage: { promptTokens: 10, completionTokens: 5 },
    });
    t.record({
      sessionId: "s1",
      userId: "u1",
      provider: "offline-stub",
      model: "stub",
      usage: { promptTokens: 1, completionTokens: 2 },
    });
    expect(t.get("s1")).toMatchObject({
      promptTokens: 11,
      completionTokens: 7,
      totalTokens: 18,
    });
  });

  it("ignores non-finite / negative numbers", () => {
    const t = new TokenTracker();
    t.record({
      sessionId: "s1",
      userId: "u1",
      provider: "offline-stub",
      model: "stub",
      usage: { promptTokens: -5, completionTokens: Number.NaN, totalTokens: Infinity },
    });
    expect(t.get("s1")).toMatchObject({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    });
  });

  it("sanitises tracker totals against integer overflow", () => {
    const t = new TokenTracker();
    t.record({
      sessionId: "s1",
      userId: "u1",
      provider: "offline-stub",
      model: "stub",
      usage: { promptTokens: Number.MAX_SAFE_INTEGER + 100 },
    });
    expect(t.get("s1")?.promptTokens).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
  });

  it("clear / clearAll empty the in-memory map", () => {
    const t = new TokenTracker();
    t.record({
      sessionId: "s1",
      userId: "u1",
      provider: "offline-stub",
      model: "stub",
      usage: { promptTokens: 1, completionTokens: 1 },
    });
    expect(t.clear("s1")).toMatchObject({ totalTokens: 2 });
    expect(t.get("s1")).toBeNull();
    t.record({
      sessionId: "s2",
      userId: "u1",
      provider: "offline-stub",
      model: "stub",
      usage: { promptTokens: 1 },
    });
    t.clearAll();
    expect(t.get("s2")).toBeNull();
  });

  it("queues a Prisma write that completes via recordAndFlush", async () => {
    const t = new TokenTracker();
    await t.recordAndFlush({
      sessionId: "s1",
      userId: "u1",
      provider: "offline-stub",
      model: "stub",
      usage: { promptTokens: 4, completionTokens: 2 },
      prompt: "hello",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId: "s1",
      userId: "u1",
      promptTokens: 4,
      completionTokens: 2,
      totalTokens: 6,
    });
    expect(rows[0].promptHash).toBeDefined();
  });

  it("skips persistence when totals are zero", async () => {
    const t = new TokenTracker();
    await t.recordAndFlush({
      sessionId: "s1",
      userId: "u1",
      provider: "offline-stub",
      model: "stub",
      usage: {},
    });
    expect(rows).toHaveLength(0);
  });

  it("dailyRollup sums the user's bucket", async () => {
    const t = new TokenTracker();
    await t.recordAndFlush({
      sessionId: "s1",
      userId: "u1",
      provider: "offline-stub",
      model: "stub",
      usage: { promptTokens: 3, completionTokens: 1 },
    });
    await t.recordAndFlush({
      sessionId: "s2",
      userId: "u1",
      provider: "offline-stub",
      model: "stub",
      usage: { promptTokens: 2, completionTokens: 4, cacheReadTokens: 5 },
    });
    const rollup = await t.dailyRollup("u1");
    expect(rollup.promptTokens).toBe(5);
    expect(rollup.completionTokens).toBe(5);
    expect(rollup.cacheReadTokens).toBe(5);
  });

  it("handles persistence failures without throwing", async () => {
    const t = new TokenTracker();
    const { prisma } = await import("../src/lib/prisma.js");
    (prisma.aITokenUsage.create as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("db down"),
    );
    await t.recordAndFlush({
      sessionId: "s1",
      userId: "u1",
      provider: "offline-stub",
      model: "stub",
      usage: { promptTokens: 1, completionTokens: 1 },
    });
    expect(t.get("s1")?.totalTokens).toBe(2);
  });
});

describe("singleton + hashPrompt", () => {
  it("getTokenTracker returns the same instance after reset", () => {
    const a = getTokenTracker();
    const b = getTokenTracker();
    expect(a).toBe(b);
    __resetTokenTrackerSingleton();
    expect(getTokenTracker()).not.toBe(a);
  });

  it("hashPrompt is stable", () => {
    expect(hashPrompt("x")).toBe(hashPrompt("x"));
    expect(hashPrompt("x")).not.toBe(hashPrompt("y"));
  });
});
