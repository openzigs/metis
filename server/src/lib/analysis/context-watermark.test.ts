/**
 * Epic #515 / #519, revived by #138 — the watermark reads the model catalog's
 * context window and reports when it had to assume one.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  ContextWatermark,
  clampAnswerReservePercent,
  clampWatermarkPercent,
  DEFAULT_ANSWER_RESERVE_PERCENT,
  DEFAULT_CONTEXT_WINDOW_FALLBACK,
  resolveAnswerReserve,
  resolveContextWindow,
} from "./context-watermark.js";
import { __resetModelCatalogForTests } from "../ai/model-catalog.js";

afterEach(() => __resetModelCatalogForTests());

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
