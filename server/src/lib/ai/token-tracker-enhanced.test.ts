/**
 * Epic #594 / Issue #605 — Enhanced TokenTracker unit tests.
 *
 * Tests the new cost estimation and extended fields (projectId,
 * inferenceProfileArn, agentStep, estimatedCostUsd).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../prisma.js", () => ({
  prisma: {
    aITokenUsage: {
      create: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
    },
  },
}));
vi.mock("../logger.js", () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { prisma } from "../prisma.js";
import {
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_MULTIPLIER_5M,
  CACHE_WRITE_MULTIPLIER_1H,
  TokenTracker,
  estimateCostUsd,
  estimateUsageCostUsd,
  getTokenTracker,
  __resetTokenTrackerSingleton,
} from "./token-tracker.js";

const mockCreate = prisma.aITokenUsage.create as ReturnType<typeof vi.fn>;

describe("estimateCostUsd", () => {
  it("estimates cost for haiku ($1/$5 per 1M)", () => {
    // 1000 input, 500 output
    // input: 1000 * 1 / 1_000_000 = 0.001
    // output: 500 * 5 / 1_000_000 = 0.0025
    const cost = estimateCostUsd("us.anthropic.claude-3-5-haiku-20241022-v1:0", 1000, 500);
    expect(cost).toBeCloseTo(0.0035);
  });

  it("estimates cost for sonnet ($3/$15 per 1M)", () => {
    const cost = estimateCostUsd("us.anthropic.claude-sonnet-4-20250514-v1:0", 1000, 500);
    // input: 1000 * 3 / 1_000_000 = 0.003
    // output: 500 * 15 / 1_000_000 = 0.0075
    expect(cost).toBeCloseTo(0.0105);
  });

  it("estimates cost for opus ($15/$75 per 1M)", () => {
    const cost = estimateCostUsd("us.anthropic.claude-opus-4-20250514-v1:0", 1000, 500);
    expect(cost).toBeCloseTo(0.0525);
  });

  it("returns 0 for unknown models", () => {
    expect(estimateCostUsd("unknown-model", 1000, 500)).toBe(0);
  });

  it("handles zero tokens", () => {
    expect(estimateCostUsd("haiku", 0, 0)).toBe(0);
  });

  it("matches model names case-insensitively", () => {
    const cost = estimateCostUsd("Claude-Haiku-v3", 1000, 0);
    expect(cost).toBeGreaterThan(0);
  });

  it("prices cache reads at 0.1× and writes at 1.25× the input rate", () => {
    // sonnet input rate = $3/1M. 1000 fresh input + 500 output + cache read/write.
    const cost = estimateCostUsd("sonnet", 1000, 500, {
      cacheReadTokens: 2000,
      cacheWriteTokens: 400,
    });
    const expected =
      (1000 * 3 +
        500 * 15 +
        2000 * 3 * CACHE_READ_MULTIPLIER +
        400 * 3 * CACHE_WRITE_MULTIPLIER_5M) /
      1_000_000;
    expect(cost).toBeCloseTo(expected, 10);
    // Concretely: (3000 + 7500 + 600 + 1500) / 1e6 = 0.0126
    expect(cost).toBeCloseTo(0.0126, 10);
  });

  it("exposes the documented multiplier values (0.1× read, 1.25× 5m write)", () => {
    expect(CACHE_READ_MULTIPLIER).toBe(0.1);
    expect(CACHE_WRITE_MULTIPLIER_5M).toBe(1.25);
  });

  it("is unchanged from legacy 3-arg behavior when no cache tokens are given", () => {
    // Regression guard: omitting the cache arg must match the pre-#698 formula.
    const legacy = estimateCostUsd("sonnet", 1000, 500);
    const withEmptyCache = estimateCostUsd("sonnet", 1000, 500, {
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(withEmptyCache).toBe(legacy);
    expect(legacy).toBeCloseTo(0.0105, 10);
  });

  it("returns 0 for unknown models even with cache tokens", () => {
    expect(
      estimateCostUsd("mystery-model", 1000, 500, {
        cacheReadTokens: 5000,
        cacheWriteTokens: 5000,
      }),
    ).toBe(0);
  });
});

describe("estimateUsageCostUsd — both provider usage conventions", () => {
  it("native-Anthropic: input_tokens EXCLUDES cache; reads+writes priced on top", () => {
    // anthropic path: promptTokens is the fresh input (excludes cache fields).
    const cost = estimateUsageCostUsd(
      "sonnet",
      {
        promptTokens: 1000,
        completionTokens: 500,
        cacheReadTokens: 2000,
        cacheWriteTokens: 400,
      },
      "anthropic",
    );
    // fresh 1000 + reads 2000@0.1× + writes 400@1.25× → 0.0126
    expect(cost).toBeCloseTo(0.0126, 10);
  });

  it("gateway (OpenAI-compatible): prompt_tokens INCLUDES reads; not double-counted", () => {
    // bedrock-gateway path: promptTokens (1000) already includes the 800 reads,
    // so the fresh remainder is 200 — reads must NOT be billed at full input rate.
    const cost = estimateUsageCostUsd(
      "sonnet",
      {
        promptTokens: 1000,
        completionTokens: 500,
        cacheReadTokens: 800,
        cacheWriteTokens: 0,
      },
      "bedrock-gateway",
    );
    // fresh 200 + reads 800@0.1× → (600 + 7500 + 240)/1e6 = 0.00834
    expect(cost).toBeCloseTo(0.00834, 10);
  });

  it("a cache-hitting call costs LESS than the identical call priced uncached", () => {
    // Same 1000-token prompt, 800 of it a cache read (gateway shape).
    const cached = estimateUsageCostUsd(
      "sonnet",
      { promptTokens: 1000, completionTokens: 500, cacheReadTokens: 800, cacheWriteTokens: 0 },
      "bedrock-gateway",
    );
    // Uncached baseline: all 1000 prompt tokens billed at full input rate.
    const uncached = estimateCostUsd("sonnet", 1000, 500);
    expect(cached).toBeLessThan(uncached);
  });

  it("zero-cache usage matches the plain input-rate estimate (regression guard)", () => {
    const usage = {
      promptTokens: 1000,
      completionTokens: 500,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    expect(estimateUsageCostUsd("sonnet", usage, "anthropic")).toBe(
      estimateCostUsd("sonnet", 1000, 500),
    );
    expect(estimateUsageCostUsd("sonnet", usage, "bedrock-gateway")).toBe(
      estimateCostUsd("sonnet", 1000, 500),
    );
  });

  it("treats absent cache fields as 0 (persisted rows without cache stay priced)", () => {
    // Old AITokenUsage rows / callers may omit the cache fields entirely.
    const cost = estimateUsageCostUsd(
      "sonnet",
      { promptTokens: 1000, completionTokens: 500 },
      "bedrock-gateway",
    );
    expect(cost).toBeCloseTo(0.0105, 10);
  });

  it("gateway path never bills cache writes (documented understatement caveat)", () => {
    // The OpenAI-compatible shape has no cache-creation field, so a stray write
    // count is dropped — gateway cost understates the write premium by design.
    const withWrite = estimateUsageCostUsd(
      "sonnet",
      { promptTokens: 1000, completionTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 500 },
      "bedrock-gateway",
    );
    const withoutWrite = estimateUsageCostUsd(
      "sonnet",
      { promptTokens: 1000, completionTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 },
      "bedrock-gateway",
    );
    expect(withWrite).toBe(withoutWrite);
  });

  it("native path DOES bill cache writes at the 1.25× premium", () => {
    const withWrite = estimateUsageCostUsd(
      "sonnet",
      { promptTokens: 1000, completionTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 500 },
      "anthropic",
    );
    const withoutWrite = estimateUsageCostUsd(
      "sonnet",
      { promptTokens: 1000, completionTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 },
      "anthropic",
    );
    expect(withWrite).toBeGreaterThan(withoutWrite);
    // write premium = 500 * 3 * 1.25 / 1e6
    expect(withWrite - withoutWrite).toBeCloseTo((500 * 3 * 1.25) / 1_000_000, 12);
  });
});

describe("estimateUsageCostUsd — config-gated 1h write multiplier (#702)", () => {
  const usage = {
    promptTokens: 1000,
    completionTokens: 500,
    cacheReadTokens: 0,
    cacheWriteTokens: 500,
  };

  it("exposes the 2× 1h write multiplier constant", () => {
    expect(CACHE_WRITE_MULTIPLIER_1H).toBe(2.0);
  });

  it("applies the 2× write multiplier on the native-Anthropic path when 1h is active", () => {
    const oneHour = estimateUsageCostUsd("sonnet", usage, "anthropic", "1h");
    const fiveMin = estimateUsageCostUsd("sonnet", usage, "anthropic", "5m");
    // Only the write term changes: 500 * 3 * (2 - 1.25) / 1e6.
    expect(oneHour - fiveMin).toBeCloseTo((500 * 3 * (2 - 1.25)) / 1_000_000, 12);
    // Absolute: fresh 1000@3 + output 500@15 + write 500@3@2× = (3000 + 7500 + 3000)/1e6.
    expect(oneHour).toBeCloseTo(0.0135, 12);
  });

  it("defaults to the 1.25× 5m multiplier when writeTtl is omitted", () => {
    const implicit = estimateUsageCostUsd("sonnet", usage, "anthropic");
    const explicit5m = estimateUsageCostUsd("sonnet", usage, "anthropic", "5m");
    expect(implicit).toBe(explicit5m);
    // (3000 + 7500 + 500*3*1.25=1875)/1e6 = 0.012375.
    expect(implicit).toBeCloseTo(0.012375, 12);
  });

  it("NEVER applies the 2× multiplier on the Bedrock/gateway path (no 1h TTL there)", () => {
    // Even if a caller passes writeTtl='1h', Bedrock stays at 1.25×. The gateway
    // usage shape also drops cache writes, so we assert on native cacheWriteTokens
    // routed through a non-anthropic provider key via estimateCostUsd equivalence.
    const bedrock1h = estimateUsageCostUsd("sonnet", usage, "bedrock-gateway", "1h");
    const bedrock5m = estimateUsageCostUsd("sonnet", usage, "bedrock-gateway", "5m");
    expect(bedrock1h).toBe(bedrock5m);
  });

  it("gates on the anthropic provider key, not just the ttl (copilot path stays 1.25×)", () => {
    const copilot1h = estimateUsageCostUsd("sonnet", usage, "copilot-native", "1h");
    const copilot5m = estimateUsageCostUsd("sonnet", usage, "copilot-native", "5m");
    expect(copilot1h).toBe(copilot5m);
  });
});

describe("TokenTracker — enhanced fields", () => {
  let tracker: TokenTracker;

  beforeEach(() => {
    __resetTokenTrackerSingleton();
    tracker = new TokenTracker();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("persists projectId, inferenceProfileArn, agentStep, and estimatedCostUsd", async () => {
    await tracker.recordAndFlush({
      sessionId: "sess-1",
      userId: "user-1",
      provider: "bedrock",
      model: "us.anthropic.claude-sonnet-4-20250514-v1:0",
      usage: { promptTokens: 100, completionTokens: 50 },
      projectId: "proj-1",
      inferenceProfileArn: "arn:aws:bedrock:us-east-1:123456789012:inference-profile/test",
      agentStep: "analysis",
    });

    expect(mockCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        projectId: "proj-1",
        inferenceProfileArn: "arn:aws:bedrock:us-east-1:123456789012:inference-profile/test",
        agentStep: "analysis",
        estimatedCostUsd: expect.any(Number),
      }),
    });

    // Verify cost was calculated for sonnet
    const callData = mockCreate.mock.calls[0][0].data;
    expect(callData.estimatedCostUsd).toBeGreaterThan(0);
  });

  it("defaults new fields to null when not provided", async () => {
    await tracker.recordAndFlush({
      sessionId: "sess-2",
      userId: "user-1",
      provider: "bedrock",
      model: "unknown-model",
      usage: { promptTokens: 10, completionTokens: 5 },
    });

    expect(mockCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        projectId: null,
        inferenceProfileArn: null,
        agentStep: null,
        estimatedCostUsd: 0, // unknown model = 0
      }),
    });
  });

  it("persists a cache-discounted estimatedCostUsd for a gateway cache hit", async () => {
    // Gateway shape: prompt_tokens (1000) includes 800 cache reads.
    await tracker.recordAndFlush({
      sessionId: "sess-cache",
      userId: "user-1",
      provider: "bedrock-gateway",
      model: "us.anthropic.claude-sonnet-4-20250514-v1:0",
      usage: {
        promptTokens: 1000,
        completionTokens: 500,
        cacheReadTokens: 800,
        cacheWriteTokens: 0,
      },
    });

    const persisted = mockCreate.mock.calls[0][0].data;
    // Cache-aware: (200 fresh + 800*0.1 reads)*3 + 500*15 → 0.00834, strictly
    // below the 0.0105 an uncached 1000-token prompt would have cost.
    expect(persisted.estimatedCostUsd).toBeCloseTo(0.00834, 10);
    expect(persisted.estimatedCostUsd).toBeLessThan(0.0105);
    // The raw token counts are still persisted verbatim (no schema change).
    expect(persisted.promptTokens).toBe(1000);
    expect(persisted.cacheReadTokens).toBe(800);
  });

  it("still tracks in-memory session totals correctly", () => {
    tracker.record({
      sessionId: "sess-3",
      userId: "user-1",
      provider: "bedrock",
      model: "haiku",
      usage: { promptTokens: 100, completionTokens: 50 },
    });
    tracker.record({
      sessionId: "sess-3",
      userId: "user-1",
      provider: "bedrock",
      model: "haiku",
      usage: { promptTokens: 200, completionTokens: 100 },
    });

    const totals = tracker.get("sess-3");
    expect(totals).not.toBeNull();
    expect(totals!.promptTokens).toBe(300);
    expect(totals!.completionTokens).toBe(150);
    expect(totals!.totalTokens).toBe(450);
  });

  it("skips persistence for zero-token events", () => {
    tracker.record({
      sessionId: "sess-4",
      userId: "user-1",
      provider: "bedrock",
      model: "haiku",
      usage: { promptTokens: 0, completionTokens: 0 },
    });

    // The create should NOT be called since all tokens are 0
    expect(mockCreate).not.toHaveBeenCalled();
  });

  describe("singleton", () => {
    it("returns same instance", () => {
      const a = getTokenTracker();
      const b = getTokenTracker();
      expect(a).toBe(b);
    });

    it("resets on __resetTokenTrackerSingleton", () => {
      const a = getTokenTracker();
      __resetTokenTrackerSingleton();
      const b = getTokenTracker();
      expect(a).not.toBe(b);
    });
  });
});
