/**
 * Unit tests for the FinOps token tracker (Epic #164).
 *
 * Verifies that recordUsage sanitizes inputs, computes costs via the rate
 * map, persists a TokenUsage row, and emits a usage:tick event for the
 * project room. Persistence is async (microtask) so the test uses the
 * `recordUsageAndFlush` helper.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface PersistedRow {
  projectId: string;
  sessionId: string | null;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costCents: number | null;
}

const persisted: PersistedRow[] = [];

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    tokenUsage: {
      create: vi.fn(async ({ data }: { data: PersistedRow }) => {
        persisted.push(data);
        return data;
      }),
    },
  },
}));

import { recordUsageAndFlush, setUsageEmitter } from "../src/lib/finops/token-tracker.js";

beforeEach(() => {
  persisted.length = 0;
  setUsageEmitter(null);
});

afterEach(() => {
  setUsageEmitter(null);
});

describe("recordUsage", () => {
  it("computes cost from provider rates and persists a row", async () => {
    const r = await recordUsageAndFlush({
      projectId: "proj-1",
      sessionId: "sess-1",
      provider: "openai",
      model: "gpt-4o",
      inputTokens: 4000,
      outputTokens: 1000,
    });
    expect(r.totalTokens).toBe(5000);
    // 4000 * 0.25/1k + 1000 * 1.0/1k = 1 + 1 = 2c
    expect(r.costCents).toBe(2);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      projectId: "proj-1",
      sessionId: "sess-1",
      provider: "openai",
      model: "gpt-4o",
      totalTokens: 5000,
      costCents: 2,
    });
  });

  it("sanitises non-finite + negative numbers", async () => {
    const r = await recordUsageAndFlush({
      projectId: "proj-1",
      sessionId: "sess-1",
      provider: "openai",
      model: "gpt-4o",
      inputTokens: Number.NaN,
      outputTokens: -10,
      cacheReadTokens: Infinity,
    });
    expect(r.totalTokens).toBe(0);
    expect(r.costCents).toBe(0);
    // No row is persisted when totalTokens is 0 (skip the write).
    expect(persisted).toHaveLength(0);
  });

  it("returns zero cost for unknown providers but still records tokens", async () => {
    const r = await recordUsageAndFlush({
      projectId: "proj-1",
      sessionId: "sess-1",
      provider: "offline-stub",
      model: "offline-stub",
      inputTokens: 100,
      outputTokens: 50,
    });
    expect(r.totalTokens).toBe(150);
    expect(r.costCents).toBe(0);
    expect(persisted).toHaveLength(1);
  });

  it("persists and emits a NULL cost for an unpriced model, never 0 (#22)", async () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", "");
    vi.stubEnv("MODEL_PRICES", "");
    const ticks: Array<{ costCents: number | null; totalTokens: number }> = [];
    setUsageEmitter((_projectId, payload) => ticks.push(payload));
    try {
      const r = await recordUsageAndFlush({
        projectId: "proj-1",
        sessionId: "sess-1",
        provider: "anthropic",
        model: "deepseek-v4-pro",
        inputTokens: 1_334_017,
        outputTokens: 1_297_372,
      });
      expect(r.costCents).toBeNull();
      expect(r.totalTokens).toBe(2_631_389);
      expect(persisted).toHaveLength(1);
      expect(persisted[0].costCents).toBeNull();
      expect(persisted[0].totalTokens).toBe(2_631_389);
      expect(ticks).toHaveLength(1);
      expect(ticks[0].costCents).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("emits usage:tick to the project room when an emitter is set", async () => {
    const emitter = vi.fn();
    setUsageEmitter(emitter);
    await recordUsageAndFlush({
      projectId: "proj-emit",
      sessionId: "sess-emit",
      provider: "openai",
      model: "gpt-4o-mini",
      inputTokens: 1000,
      outputTokens: 500,
    });
    expect(emitter).toHaveBeenCalledWith(
      "proj-emit",
      expect.objectContaining({
        projectId: "proj-emit",
        sessionId: "sess-emit",
        provider: "openai",
        model: "gpt-4o-mini",
        totalTokens: 1500,
      }),
    );
  });

  it("survives emitter throws without crashing the caller", async () => {
    setUsageEmitter(() => {
      throw new Error("boom");
    });
    await expect(
      recordUsageAndFlush({
        projectId: "p",
        sessionId: "s",
        provider: "openai",
        model: "gpt-4o",
        inputTokens: 100,
        outputTokens: 0,
      }),
    ).resolves.toBeDefined();
  });
});
