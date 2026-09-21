/**
 * Issue #390 — Bedrock prompt-cache hit-ratio telemetry (metric/log emission).
 *
 * Verifies the in-process aggregator: per-call hit-ratio math (with a strict
 * divide-by-zero guard), per-call-type/per-model accumulation, the per-call
 * log line (tagged by call type AND model), and the OWASP requirement that NO
 * secret (API key / Authorization header / full ARN) appears in any emission.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Capture the structured log lines so we can assert tags + secret-redaction.
// `vi.hoisted` makes the spies available inside the hoisted `vi.mock` factory.
const { logInfo, logDebug, logWarn } = vi.hoisted(() => ({
  logInfo: vi.fn(),
  logDebug: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock("../logger.js", () => ({
  createChildLogger: () => ({
    debug: logDebug,
    info: logInfo,
    warn: logWarn,
    error: vi.fn(),
  }),
}));

const {
  computeCacheHitRatio,
  computeReadWriteRatio,
  CacheHitAggregator,
  recordCacheHit,
  getCacheHitAggregator,
  __resetCacheHitAggregatorSingleton,
} = await import("./cache-hit-telemetry.js");

beforeEach(() => {
  logInfo.mockClear();
  logDebug.mockClear();
  logWarn.mockClear();
  __resetCacheHitAggregatorSingleton();
});

afterEach(() => {
  __resetCacheHitAggregatorSingleton();
});

describe("computeCacheHitRatio", () => {
  it("computes cacheReadTokens / promptTokens", () => {
    expect(computeCacheHitRatio(512, 1024)).toBeCloseTo(0.5, 6);
  });

  it("returns 1 for a full hit", () => {
    expect(computeCacheHitRatio(1024, 1024)).toBe(1);
  });

  it("returns 0 when promptTokens is 0 (divide-by-zero guard, no throw)", () => {
    expect(() => computeCacheHitRatio(0, 0)).not.toThrow();
    expect(computeCacheHitRatio(0, 0)).toBe(0);
    // Even a nonzero read with zero prompt must not yield Infinity/NaN.
    expect(computeCacheHitRatio(10, 0)).toBe(0);
  });

  it("returns 0 for negative/NaN inputs rather than a bogus ratio", () => {
    expect(computeCacheHitRatio(-5, 1024)).toBe(0);
    expect(computeCacheHitRatio(Number.NaN, 1024)).toBe(0);
    expect(computeCacheHitRatio(512, Number.NaN)).toBe(0);
  });

  it("clamps a read larger than the prompt to a ratio of 1", () => {
    expect(computeCacheHitRatio(2048, 1024)).toBe(1);
  });
});

describe("computeReadWriteRatio", () => {
  it("computes cacheReadTokens / cacheWriteTokens (reads-per-write)", () => {
    expect(computeReadWriteRatio(900, 100)).toBeCloseTo(9, 6);
  });

  it("returns null when there are no cache writes (gateway path — creation not surfaced)", () => {
    expect(computeReadWriteRatio(500, 0)).toBeNull();
  });

  it("returns null for negative/NaN inputs rather than a bogus ratio", () => {
    expect(computeReadWriteRatio(100, -1)).toBeNull();
    expect(computeReadWriteRatio(Number.NaN, 100)).toBeNull();
    expect(computeReadWriteRatio(100, Number.NaN)).toBeNull();
  });

  it("clamps a negative read to 0 before dividing", () => {
    expect(computeReadWriteRatio(-50, 100)).toBe(0);
  });
});

describe("CacheHitAggregator", () => {
  it("accumulates totals per call type and model across multiple calls", () => {
    const agg = new CacheHitAggregator();
    agg.record({
      callType: "synthesis",
      model: "claude-sonnet",
      cacheReadTokens: 100,
      promptTokens: 200,
    });
    agg.record({
      callType: "synthesis",
      model: "claude-sonnet",
      cacheReadTokens: 300,
      promptTokens: 300,
    });

    const stats = agg.snapshot("synthesis", "claude-sonnet");
    expect(stats).toEqual({
      callType: "synthesis",
      model: "claude-sonnet",
      calls: 2,
      sumCacheReadTokens: 400,
      // no cacheWriteTokens supplied (gateway path) → 0
      sumCacheWriteTokens: 0,
      sumPromptTokens: 500,
      // rolling ratio = sumRead / sumPrompt = 400 / 500
      hitRatio: 0.8,
    });
  });

  it("accumulates cache CREATION (write) tokens where a path supplies them", () => {
    const agg = new CacheHitAggregator();
    // Native-Anthropic-shaped samples carry cacheWriteTokens; gateway ones omit it.
    agg.record({
      callType: "synthesis",
      model: "claude-sonnet",
      cacheReadTokens: 100,
      cacheWriteTokens: 40,
      promptTokens: 200,
    });
    agg.record({
      callType: "synthesis",
      model: "claude-sonnet",
      cacheReadTokens: 300,
      cacheWriteTokens: 10,
      promptTokens: 300,
    });
    const stats = agg.snapshot("synthesis", "claude-sonnet");
    expect(stats?.sumCacheWriteTokens).toBe(50);
    expect(stats?.sumCacheReadTokens).toBe(400);
  });

  it("treats a negative/NaN cacheWriteTokens as 0", () => {
    const agg = new CacheHitAggregator();
    agg.record({
      callType: "chat",
      model: "m",
      cacheReadTokens: 10,
      cacheWriteTokens: Number.NaN,
      promptTokens: 100,
    });
    agg.record({
      callType: "chat",
      model: "m",
      cacheReadTokens: 10,
      cacheWriteTokens: -5,
      promptTokens: 100,
    });
    expect(agg.snapshot("chat", "m")?.sumCacheWriteTokens).toBe(0);
  });

  it("keeps separate buckets per (callType, model) pair", () => {
    const agg = new CacheHitAggregator();
    agg.record({ callType: "agent-loop", model: "m1", cacheReadTokens: 10, promptTokens: 100 });
    agg.record({ callType: "grounding", model: "m1", cacheReadTokens: 50, promptTokens: 100 });
    agg.record({ callType: "agent-loop", model: "m2", cacheReadTokens: 90, promptTokens: 100 });

    expect(agg.snapshot("agent-loop", "m1")?.hitRatio).toBeCloseTo(0.1, 6);
    expect(agg.snapshot("grounding", "m1")?.hitRatio).toBeCloseTo(0.5, 6);
    expect(agg.snapshot("agent-loop", "m2")?.hitRatio).toBeCloseTo(0.9, 6);
    expect(agg.allSnapshots()).toHaveLength(3);
  });

  it("returns undefined snapshot for an unseen bucket", () => {
    const agg = new CacheHitAggregator();
    expect(agg.snapshot("chat", "never-seen")).toBeUndefined();
  });

  it("guards divide-by-zero in the rolling ratio (all promptTokens 0 -> ratio 0)", () => {
    const agg = new CacheHitAggregator();
    agg.record({ callType: "chat", model: "m", cacheReadTokens: 0, promptTokens: 0 });
    const stats = agg.snapshot("chat", "m");
    expect(stats?.hitRatio).toBe(0);
    expect(stats?.calls).toBe(1);
  });

  it("reset() clears all buckets", () => {
    const agg = new CacheHitAggregator();
    agg.record({ callType: "chat", model: "m", cacheReadTokens: 1, promptTokens: 2 });
    agg.reset();
    expect(agg.allSnapshots()).toHaveLength(0);
    expect(agg.snapshot("chat", "m")).toBeUndefined();
  });
});

describe("recordCacheHit (per-call emission)", () => {
  it("emits a log line tagged by call type AND model with the correct ratio", () => {
    recordCacheHit({
      callType: "grounding",
      model: "claude-sonnet-4",
      cacheReadTokens: 768,
      promptTokens: 1024,
    });

    expect(logInfo).toHaveBeenCalledTimes(1);
    const [msg, meta] = logInfo.mock.calls[0] as [string, Record<string, unknown>];
    expect(msg).toMatch(/cache.?hit/i);
    expect(meta).toMatchObject({
      callType: "grounding",
      model: "claude-sonnet-4",
      cacheReadTokens: 768,
      promptTokens: 1024,
    });
    // 768 / 1024 = 0.75
    expect(meta.hitRatio).toBeCloseTo(0.75, 6);
  });

  it("accumulates into the shared singleton aggregator", () => {
    recordCacheHit({ callType: "chat", model: "m", cacheReadTokens: 1, promptTokens: 4 });
    recordCacheHit({ callType: "chat", model: "m", cacheReadTokens: 3, promptTokens: 4 });

    const stats = getCacheHitAggregator().snapshot("chat", "m");
    expect(stats?.calls).toBe(2);
    expect(stats?.sumCacheReadTokens).toBe(4);
    expect(stats?.sumPromptTokens).toBe(8);
    expect(stats?.hitRatio).toBe(0.5);
  });

  it("threads cacheWriteTokens through to the aggregator and the log line", () => {
    recordCacheHit({
      callType: "synthesis",
      model: "m",
      cacheReadTokens: 80,
      cacheWriteTokens: 20,
      promptTokens: 100,
    });
    const stats = getCacheHitAggregator().snapshot("synthesis", "m");
    expect(stats?.sumCacheWriteTokens).toBe(20);
    const [, meta] = logInfo.mock.calls[0] as [string, Record<string, unknown>];
    expect(meta.cacheWriteTokens).toBe(20);
  });

  it("defaults a missing cacheWriteTokens to 0 (gateway path)", () => {
    recordCacheHit({ callType: "chat", model: "m", cacheReadTokens: 5, promptTokens: 10 });
    expect(getCacheHitAggregator().snapshot("chat", "m")?.sumCacheWriteTokens).toBe(0);
  });

  it("defaults a missing call type to 'unknown'", () => {
    recordCacheHit({
      model: "m",
      cacheReadTokens: 0,
      promptTokens: 10,
    } as Parameters<typeof recordCacheHit>[0]);
    const [, meta] = logInfo.mock.calls[0] as [string, Record<string, unknown>];
    expect(meta.callType).toBe("unknown");
  });

  it("emits ratio 0 (no throw) when promptTokens is 0", () => {
    expect(() =>
      recordCacheHit({ callType: "chat", model: "m", cacheReadTokens: 0, promptTokens: 0 }),
    ).not.toThrow();
    const [, meta] = logInfo.mock.calls[0] as [string, Record<string, unknown>];
    expect(meta.hitRatio).toBe(0);
  });

  it("NEVER includes a secret (api key / Authorization header / full ARN) in the emission", () => {
    const secretArn =
      "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abcd1234";
    recordCacheHit({
      callType: "synthesis",
      // A malicious/buggy caller could pass an ARN as the "model" — the emitter
      // must redact it so the full ARN never lands in logs (OWASP A09).
      model: secretArn,
      cacheReadTokens: 100,
      promptTokens: 200,
    });
    const serialized = JSON.stringify(logInfo.mock.calls);
    expect(serialized).not.toContain(secretArn);
    expect(serialized).not.toMatch(/123456789012/); // AWS account id must not leak
    expect(serialized).not.toMatch(/Bearer /i);
    expect(serialized).not.toMatch(/Authorization/i);
    expect(serialized).not.toMatch(/sk-[A-Za-z0-9]/); // no API-key-looking token
  });
});

describe("getCacheHitAggregator", () => {
  it("returns a stable singleton", () => {
    const a = getCacheHitAggregator();
    const b = getCacheHitAggregator();
    expect(a).toBe(b);
  });

  it("__reset replaces the singleton", () => {
    const a = getCacheHitAggregator();
    __resetCacheHitAggregatorSingleton();
    const b = getCacheHitAggregator();
    expect(a).not.toBe(b);
  });
});
