/**
 * Epic #515 / #519, revived by #138 — the watermark reads the model catalog's
 * context window and reports when it had to assume one.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../logger.js", () => ({
  createChildLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() }),
}));

import {
  __contextWindowFallbackWarningCount,
  __resetContextWindowFallbackWarnings,
  ContextWatermark,
  clampAnswerReservePercent,
  clampWatermarkPercent,
  DEFAULT_ANSWER_RESERVE_PERCENT,
  DEFAULT_CONTEXT_WINDOW_FALLBACK,
  FALLBACK_WARNING_CAP,
  resolveAnswerReserve,
  resolveContextWindow,
} from "./context-watermark.js";
import { __resetModelCatalogForTests } from "../ai/model-catalog.js";

afterEach(() => {
  __resetModelCatalogForTests();
  __resetContextWindowFallbackWarnings();
  warn.mockClear();
});

describe("resolveContextWindow (#138)", () => {
  it("uses the catalog's real window — Sonnet 5 is 1M, not the old table's 200K", () => {
    expect(resolveContextWindow("anthropic", "claude-sonnet-5")).toEqual({
      tokens: 1_000_000,
      source: "catalog",
    });
    expect(resolveContextWindow("anthropic", "claude-haiku-4-5").tokens).toBe(200_000);
    expect(resolveContextWindow("openai", "gpt-4o").tokens).toBe(128_000);
  });

  it("an operator override wins (a local model's served window)", () => {
    const env = {
      AI_MODEL_CATALOG_OVERRIDES: JSON.stringify({
        "local-gemma:laguna-s-2.1": { contextWindow: 262_144 },
      }),
    };
    expect(resolveContextWindow("local-gemma", "laguna-s-2.1", { env })).toEqual({
      tokens: 262_144,
      source: "catalog",
    });
  });

  it("an unknown model gets the fallback, labelled as a fallback", () => {
    expect(resolveContextWindow("local-gemma", "mystery:1b", { env: {} })).toEqual({
      tokens: DEFAULT_CONTEXT_WINDOW_FALLBACK,
      source: "fallback",
    });
    expect(
      resolveContextWindow("local-gemma", "mystery:1b", { fallback: 65_536, env: {} }),
    ).toEqual({
      tokens: 65_536,
      source: "fallback",
    });
  });

  it("ignores a nonsense fallback", () => {
    expect(resolveContextWindow("x", "y", { fallback: 10, env: {} }).tokens).toBe(
      DEFAULT_CONTEXT_WINDOW_FALLBACK,
    );
    expect(resolveContextWindow("x", "y", { fallback: Number.NaN, env: {} }).tokens).toBe(
      DEFAULT_CONTEXT_WINDOW_FALLBACK,
    );
  });

  it("the offline stub's 0-token window is unknown, not zero", () => {
    expect(resolveContextWindow("offline-stub", "offline-stub", { env: {} }).source).toBe(
      "fallback",
    );
  });
});

describe("a Claude family id on the Bedrock gateway or an Anthropic endpoint (#2599)", () => {
  const SONNET_5_5_SPELLINGS = [
    "us.anthropic.claude-sonnet-5-5",
    "us.anthropic.claude-sonnet-5-5-20260101-v1:0",
    "eu.anthropic.claude-sonnet-5-5-20260101-v1:0",
    "global.anthropic.claude-sonnet-5-5-v1:0",
    "anthropic.claude-sonnet-5-5-20260101-v1:0",
    "anthropic.claude-sonnet-5-5-v1",
    "claude-sonnet-5-5-20260101",
  ];

  it.each(SONNET_5_5_SPELLINGS)("reads %s as Sonnet 5.5's 1M window on bedrock-gateway", (id) => {
    expect(resolveContextWindow("bedrock-gateway", id, { env: {} })).toEqual({
      tokens: 1_000_000,
      source: "catalog",
    });
  });

  it("reads an undated in-region id on the Anthropic provider too", () => {
    expect(
      resolveContextWindow("anthropic", "anthropic.claude-sonnet-5-5-v1:0", { env: {} }).tokens,
    ).toBe(1_000_000);
  });

  it("takes each family's own window, not Sonnet's", () => {
    expect(
      resolveContextWindow("bedrock-gateway", "us.anthropic.claude-haiku-4-5-v1:0", { env: {} })
        .tokens,
    ).toBe(200_000);
  });

  it("reserves the family's output ceiling for the answer", () => {
    expect(
      resolveAnswerReserve("bedrock-gateway", "us.anthropic.claude-sonnet-5-5", 1_000_000, {
        percent: 50,
        env: {},
      }),
    ).toEqual({ tokens: 128_000, source: "catalog" });
  });

  it("an operator override still wins over the family", () => {
    const env = {
      AI_MODEL_CATALOG_OVERRIDES: JSON.stringify({
        "bedrock-gateway:us.anthropic.claude-sonnet-5-5": { contextWindow: 200_000 },
      }),
    };
    expect(
      resolveContextWindow("bedrock-gateway", "us.anthropic.claude-sonnet-5-5", { env }),
    ).toEqual({ tokens: 200_000, source: "catalog" });
  });

  it("never guesses a window for a generation with no row, or on another provider", () => {
    for (const [provider, id] of [
      ["bedrock-gateway", "us.anthropic.claude-sonnet-5-6"],
      ["openai", "us.anthropic.claude-sonnet-5-5"],
    ]) {
      expect(resolveContextWindow(provider, id, { env: {} })).toEqual({
        tokens: DEFAULT_CONTEXT_WINDOW_FALLBACK,
        source: "fallback",
      });
    }
  });
});

describe("the fallback warning (#2599)", () => {
  it("warns once per model that runs on the assumed window", () => {
    resolveContextWindow("local-gemma", "mystery:1b", { env: {} });
    resolveContextWindow("local-gemma", "mystery:1b", { env: {} });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toEqual({
      provider: "local-gemma",
      model: "mystery:1b",
      assumedContextWindow: DEFAULT_CONTEXT_WINDOW_FALLBACK,
    });
    expect(warn.mock.calls[0][0]).toContain("AI_MODEL_CATALOG_OVERRIDES");
    resolveContextWindow("local-gemma", "other:2b", { env: {} });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("stops recording after FALLBACK_WARNING_CAP models, so request-supplied ids cannot grow it", () => {
    for (let i = 0; i < FALLBACK_WARNING_CAP + 50; i += 1) {
      resolveContextWindow("openai", `mystery-${i}`, { env: {} });
    }
    // One warning per model up to the cap, then one saying the rest go unreported.
    expect(warn).toHaveBeenCalledTimes(FALLBACK_WARNING_CAP + 1);
    expect(warn.mock.calls[FALLBACK_WARNING_CAP][1]).toEqual({ cap: FALLBACK_WARNING_CAP });
    expect(__contextWindowFallbackWarningCount()).toBe(FALLBACK_WARNING_CAP);
    // A model recorded before the cap is still deduplicated.
    resolveContextWindow("openai", "mystery-0", { env: {} });
    expect(warn).toHaveBeenCalledTimes(FALLBACK_WARNING_CAP + 1);
    // The fallback itself is unchanged past the cap.
    expect(resolveContextWindow("openai", "mystery-new", { env: {} })).toEqual({
      tokens: DEFAULT_CONTEXT_WINDOW_FALLBACK,
      source: "fallback",
    });
  });

  it("is silent when the catalog knows the window, and for the offline stub", () => {
    resolveContextWindow("bedrock-gateway", "us.anthropic.claude-sonnet-5-5", { env: {} });
    resolveContextWindow("offline-stub", "offline-stub", { env: {} });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("clampWatermarkPercent", () => {
  it("defaults to 80 and clamps into 10..95", () => {
    expect(clampWatermarkPercent(undefined)).toBe(80);
    expect(clampWatermarkPercent(Number.NaN)).toBe(80);
    expect(clampWatermarkPercent(1)).toBe(10);
    expect(clampWatermarkPercent(200)).toBe(95);
    expect(clampWatermarkPercent(70.4)).toBe(70);
  });
});

describe("ContextWatermark", () => {
  const window = { tokens: 10_000, source: "catalog" as const };

  it("fires at 80% of the window by default", () => {
    const w = new ContextWatermark({ contextWindow: window });
    expect(w.watermarkTokens).toBe(8_000);
    expect(w.check(7_999).overWatermark).toBe(false);
    expect(w.check(8_000).overWatermark).toBe(true);
  });

  it("reports overflow past the window itself", () => {
    const w = new ContextWatermark({ contextWindow: window });
    expect(w.check(10_000).overWindow).toBe(false);
    expect(w.check(10_001).overWindow).toBe(true);
    expect(w.check(5_000).utilization).toBe(0.5);
  });

  it("a configured threshold caps the watermark but never raises it", () => {
    expect(
      new ContextWatermark({ contextWindow: window, thresholdTokens: 3_000 }).watermarkTokens,
    ).toBe(3_000);
    expect(
      new ContextWatermark({ contextWindow: window, thresholdTokens: 50_000 }).watermarkTokens,
    ).toBe(8_000);
    expect(
      new ContextWatermark({ contextWindow: window, thresholdTokens: 0 }).watermarkTokens,
    ).toBe(8_000);
  });

  it("carries the window's source into every check", () => {
    const w = new ContextWatermark({
      contextWindow: { tokens: 32_768, source: "fallback" },
      watermarkPercent: 50,
    });
    expect(w.check(1).contextWindowSource).toBe("fallback");
    expect(w.watermarkTokens).toBe(16_384);
  });

  it("a zero window reads as fully used", () => {
    expect(
      new ContextWatermark({ contextWindow: { tokens: 0, source: "fallback" } }).check(0)
        .utilization,
    ).toBe(1);
  });
});

// #213 — the overflow check leaves room for the reply.
describe("answer reserve (#213)", () => {
  const window = { tokens: 10_000, source: "catalog" as const };

  it("defaults to 10% of the window and clamps a configured share into 0..50", () => {
    expect(DEFAULT_ANSWER_RESERVE_PERCENT).toBe(10);
    expect(clampAnswerReservePercent(undefined)).toBe(10);
    expect(clampAnswerReservePercent(Number.NaN)).toBe(10);
    expect(clampAnswerReservePercent(-5)).toBe(0);
    expect(clampAnswerReservePercent(80)).toBe(50);
    expect(clampAnswerReservePercent(12.6)).toBe(13);
  });

  it("is the window share when the catalog does not know the model's output cap", () => {
    expect(resolveAnswerReserve("local-gemma", "mystery:1b", 32_768, { env: {} })).toEqual({
      tokens: 3_276,
      source: "window-share",
    });
  });

  it("is the catalog's maxOutputTokens when that is the smaller bound", () => {
    const env = {
      AI_MODEL_CATALOG_OVERRIDES: JSON.stringify({
        "local-gemma:tiny-out": { contextWindow: 100_000, maxOutputTokens: 4_096 },
      }),
    };
    expect(resolveAnswerReserve("local-gemma", "tiny-out", 100_000, { env })).toEqual({
      tokens: 4_096,
      source: "catalog",
    });
  });

  it("never reserves a catalog output cap larger than the window share (no false 413s)", () => {
    const env = {
      AI_MODEL_CATALOG_OVERRIDES: JSON.stringify({
        "local-gemma:huge-out": { contextWindow: 200_000, maxOutputTokens: 128_000 },
      }),
    };
    expect(resolveAnswerReserve("local-gemma", "huge-out", 200_000, { env })).toEqual({
      tokens: 20_000,
      source: "window-share",
    });
  });

  it("0% turns the reserve off", () => {
    expect(resolveAnswerReserve("x", "y", 10_000, { percent: 0, env: {} })).toEqual({
      tokens: 0,
      source: "off",
    });
  });

  it("overflows at prompt + reserve = window + 1, not at window", () => {
    const w = new ContextWatermark({ contextWindow: window, answerReserveTokens: 1_000 });
    expect(w.check(8_999).overWindow).toBe(false); // prompt + reserve = window − 1
    expect(w.check(9_000).overWindow).toBe(false); // prompt + reserve = window
    expect(w.check(9_001).overWindow).toBe(true); // prompt + reserve = window + 1
    expect(w.check(9_001).answerReserveTokens).toBe(1_000);
  });

  it("the watermark never sits above window − reserve, so compaction is tried before a 413", () => {
    const w = new ContextWatermark({
      contextWindow: window,
      watermarkPercent: 95,
      answerReserveTokens: 1_000,
    });
    expect(w.watermarkTokens).toBe(9_000);
    const atEdge = w.check(9_000);
    expect(atEdge.overWatermark).toBe(true);
    expect(atEdge.overWindow).toBe(false);
    // Below that, the configured watermark is untouched.
    expect(
      new ContextWatermark({ contextWindow: window, answerReserveTokens: 1_000 }).watermarkTokens,
    ).toBe(8_000);
  });

  it("a nonsense reserve is none, and a reserve larger than the window is capped at it", () => {
    for (const r of [0, -1, Number.NaN]) {
      expect(
        new ContextWatermark({ contextWindow: window, answerReserveTokens: r }).answerReserveTokens,
      ).toBe(0);
    }
    const all = new ContextWatermark({ contextWindow: window, answerReserveTokens: 50_000 });
    expect(all.answerReserveTokens).toBe(10_000);
    expect(all.check(1).overWindow).toBe(true);
  });
});
