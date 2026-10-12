/**
 * #178 — the per-run estimated cost logged at the end of a document generation.
 * Prices come from lib/finops/provider-rates.ts; nothing here invents one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logInfo = vi.hoisted(() => vi.fn());
const logWarn = vi.hoisted(() => vi.fn());
vi.mock("../logger.js", () => ({
  createChildLogger: () => ({ info: logInfo, warn: logWarn, error: vi.fn(), debug: vi.fn() }),
}));

import {
  RunUsage,
  estimateRunCost,
  logRunCost,
  noteRunUsage,
  withDocsGenRunCost,
} from "./run-cost.js";

const CTX = { projectId: "p1", docType: "business-requirements" };

beforeEach(() => {
  logInfo.mockReset();
  logWarn.mockReset();
  // A third-party ANTHROPIC_BASE_URL would unprice the anthropic rows.
  vi.stubEnv("ANTHROPIC_BASE_URL", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("estimateRunCost", () => {
  it("prices a Claude model from the published rates, including cache reads", () => {
    const usage = new RunUsage();
    // Sonnet 4.6 on native Anthropic: $3 in / $15 out / $0.30 cache read per MTok.
    usage.add({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheReadTokens: 1_000_000,
    });
    usage.add({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      inputTokens: 1_000_000,
      outputTokens: 100_000,
    });
    const estimate = estimateRunCost(usage);
    expect(estimate.calls).toBe(2);
    expect(estimate.lines).toHaveLength(1);
    expect(estimate.lines[0]).toMatchObject({
      pricing: "priced",
      calls: 2,
      inputTokens: 2_000_000,
      outputTokens: 200_000,
      cacheReadTokens: 1_000_000,
    });
    // 2M × $3 + 0.2M × $15 + 1M × $0.30 = $6 + $3 + $0.30
    expect(estimate.estimatedCostUsd).toBeCloseTo(9.3, 6);
  });

  it("does not bill a gateway's cache reads twice (they are inside its prompt count)", () => {
    const usage = new RunUsage();
    usage.add({
      provider: "bedrock-gateway",
      model: "global.anthropic.claude-sonnet-4-6",
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
    });
    // All 1M prompt tokens were cache reads: $0.30, not $3 + $0.30.
    expect(estimateRunCost(usage).estimatedCostUsd).toBeCloseTo(0.3, 6);
  });

  it("prices each Haiku 5.5 call in its own prompt-length tier, not the run's summed tokens (#1080)", () => {
    const usage = new RunUsage();
    const call = (inputTokens: number, cacheReadTokens = 0) =>
      usage.add({
        provider: "anthropic",
        model: "claude-haiku-5-5",
        inputTokens,
        outputTokens: 0,
        cacheReadTokens,
      });
    // Two 60,000-token calls: 120,000 tokens together, each under 100,000.
    call(60_000);
    call(60_000);
    // One call over the threshold, counting its cache read: 50,000 + 100,000.
    call(50_000, 100_000);
    const estimate = estimateRunCost(usage);
    expect(estimate.calls).toBe(3);
    expect(estimate.lines.map((l) => [l.promptTier ?? "standard", l.calls, l.inputTokens])).toEqual(
      [
        ["standard", 2, 120_000],
        ["long", 1, 50_000],
      ],
    );
    // 120,000 × $0.10/M = $0.012 at the lower prices;
    // 50,000 × $0.50/M + 100,000 × $0.05/M = $0.025 + $0.005 at the higher.
    expect(estimate.lines[0]!.costUsd).toBeCloseTo(0.012, 12);
    expect(estimate.lines[1]!.costUsd).toBeCloseTo(0.03, 12);
    expect(estimate.estimatedCostUsd).toBeCloseTo(0.042, 12);
  });

  it("keeps one line for a model with no prompt-length tier, however long its prompts (#1080)", () => {
    const usage = new RunUsage();
    usage.add({
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      inputTokens: 500_000,
      outputTokens: 0,
    });
    usage.add({
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      inputTokens: 1,
      outputTokens: 0,
    });
    const estimate = estimateRunCost(usage);
    expect(estimate.lines).toHaveLength(1);
    expect(estimate.lines[0]).not.toHaveProperty("promptTier");
    // 500,001 × $2/M
    expect(estimate.estimatedCostUsd).toBeCloseTo(1.000002, 12);
  });

  it("marks local-gemma self-hosted and a model with no price unpriced, never $0", () => {
    const usage = new RunUsage();
    usage.add({
      provider: "local-gemma",
      model: "laguna-s-2.1",
      inputTokens: 500,
      outputTokens: 50,
    });
    usage.add({ provider: "openai", model: "mystery-model-9", inputTokens: 10, outputTokens: 1 });
    const estimate = estimateRunCost(usage);
    expect(estimate.estimatedCostUsd).toBeNull();
    expect(estimate.lines.map((l) => [l.provider, l.pricing, l.costUsd])).toEqual([
      ["local-gemma", "self-hosted", null],
      ["openai", "unpriced", null],
    ]);
  });

  it("labels a zero-priced hosted provider zero-priced, not self-hosted (PR #181 review)", () => {
    const usage = new RunUsage();
    usage.add({ provider: "offline-stub", model: "default", inputTokens: 10, outputTokens: 1 });
    const estimate = estimateRunCost(usage);
    expect(estimate.estimatedCostUsd).toBeNull();
    expect(estimate.lines.map((l) => [l.provider, l.pricing, l.costUsd])).toEqual([
      ["offline-stub", "zero-priced", null],
    ]);
    logRunCost({ ...CTX, outcome: "completed" }, usage);
    expect(logInfo).toHaveBeenCalledWith(
      "Docs-gen run cost not estimated",
      expect.objectContaining({
        note: "configured per-token price is zero for offline-stub/default",
      }),
    );
  });

  it("ignores negative and non-finite token counts", () => {
    const usage = new RunUsage();
    usage.add({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      inputTokens: -5,
      outputTokens: Number.NaN,
      cacheReadTokens: Number.POSITIVE_INFINITY,
    });
    expect(estimateRunCost(usage).lines[0]).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
    });
  });
});

describe("logRunCost", () => {
  it("logs the priced total and names the unpriced models it leaves out", () => {
    const usage = new RunUsage();
    usage.add({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    usage.add({ provider: "openai", model: "mystery-model-9", inputTokens: 10, outputTokens: 1 });
    logRunCost({ ...CTX, outcome: "completed" }, usage);
    expect(logInfo).toHaveBeenCalledWith(
      "Docs-gen estimated run cost",
      expect.objectContaining({
        projectId: "p1",
        outcome: "completed",
        calls: 2,
        estimatedCostUsd: 1,
        byModel: [{ model: "anthropic/claude-haiku-4-5", calls: 1, costUsd: 1 }],
        unpricedModels: ["openai/mystery-model-9"],
      }),
    );
  });

  it("logs a prompt-length-priced model's two tiers as separate lines (#1080)", () => {
    const usage = new RunUsage();
    const call = (inputTokens: number) =>
      usage.add({ provider: "anthropic", model: "claude-haiku-5-5", inputTokens, outputTokens: 0 });
    call(100_000);
    call(200_000);
    logRunCost({ ...CTX, outcome: "completed" }, usage);
    expect(logInfo).toHaveBeenCalledWith(
      "Docs-gen estimated run cost",
      expect.objectContaining({
        calls: 2,
        inputTokens: 300_000,
        // 100,000 × $0.10/M + 200,000 × $0.50/M
        estimatedCostUsd: 0.11,
        byModel: [
          { model: "anthropic/claude-haiku-5-5", calls: 1, costUsd: 0.01 },
          { model: "anthropic/claude-haiku-5-5", calls: 1, costUsd: 0.1, promptTier: "long" },
        ],
      }),
    );
  });

  it("skips the estimate with a note on a local run", () => {
    const usage = new RunUsage();
    usage.add({
      provider: "local-gemma",
      model: "laguna-s-2.1",
      inputTokens: 500,
      outputTokens: 50,
    });
    logRunCost({ ...CTX, outcome: "completed" }, usage);
    expect(logInfo).toHaveBeenCalledWith(
      "Docs-gen run cost not estimated",
      expect.objectContaining({
        calls: 1,
        inputTokens: 500,
        outputTokens: 50,
        note: "no per-token price for self-hosted local-gemma/laguna-s-2.1",
      }),
    );
    expect(logInfo).not.toHaveBeenCalledWith("Docs-gen estimated run cost", expect.anything());
  });

  it("says so when no call was recorded", () => {
    logRunCost({ ...CTX, outcome: "completed" }, new RunUsage());
    expect(logInfo).toHaveBeenCalledWith(
      "Docs-gen run cost not estimated",
      expect.objectContaining({ calls: 0, note: "no model calls were recorded for this run" }),
    );
  });

  it("names a model with no configured price in the note", () => {
    const usage = new RunUsage();
    usage.add({ provider: "openai", model: "mystery-model-9", inputTokens: 10, outputTokens: 1 });
    logRunCost({ ...CTX, outcome: "failed" }, usage);
    expect(logInfo).toHaveBeenCalledWith(
      "Docs-gen run cost not estimated",
      expect.objectContaining({ note: "no configured price for openai/mystery-model-9" }),
    );
  });
});

describe("withDocsGenRunCost", () => {
  const sonnet = (inputTokens: number) =>
    noteRunUsage({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      inputTokens,
      outputTokens: 0,
    });

  it("tallies each run separately, even when two runs interleave", async () => {
    const tick = () => new Promise<void>((r) => setImmediate(r));
    await Promise.all([
      withDocsGenRunCost({ projectId: "a", docType: "d" }, async () => {
        sonnet(1_000_000);
        await tick();
        sonnet(1_000_000);
      }),
      withDocsGenRunCost({ projectId: "b", docType: "d" }, async () => {
        await tick();
        sonnet(1_000_000);
      }),
    ]);
    const byProject = Object.fromEntries(
      logInfo.mock.calls.map(([, f]) => [f.projectId, [f.calls, f.estimatedCostUsd]]),
    );
    expect(byProject).toEqual({ a: [2, 6], b: [1, 3] });
  });

  it("ignores usage noted outside any run", () => {
    expect(() => sonnet(1)).not.toThrow();
    expect(logInfo).not.toHaveBeenCalled();
  });

  it("logs a failed run's spend and rethrows its error", async () => {
    await expect(
      withDocsGenRunCost(CTX, async () => {
        sonnet(1_000_000);
        throw new Error("section failed");
      }),
    ).rejects.toThrow("section failed");
    expect(logInfo).toHaveBeenCalledWith(
      "Docs-gen estimated run cost",
      expect.objectContaining({ outcome: "failed", estimatedCostUsd: 3 }),
    );
  });

  it("returns the run's result, and a failure to estimate never changes it", async () => {
    logInfo.mockImplementationOnce(() => {
      throw new Error("logger down");
    });
    await expect(
      withDocsGenRunCost(CTX, async () => {
        sonnet(1);
        return "doc";
      }),
    ).resolves.toBe("doc");
    expect(logWarn).toHaveBeenCalledWith(
      "Docs-gen run cost could not be estimated",
      expect.objectContaining({ err: "Error: logger down" }),
    );
  });
});
