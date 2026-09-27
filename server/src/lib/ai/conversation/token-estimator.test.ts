/**
 * #137 — per-provider token accounting and the calibrated pre-send estimate.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  CALIBRATION_WINDOW,
  DEFAULT_CHARS_PER_TOKEN,
  MESSAGE_OVERHEAD_TOKENS,
  calibratedRatio,
  contextInputTokens,
  estimateCharTokens,
  estimateMessagesTokens,
  estimateTextTokens,
  promptChars,
  resolveTokenRatio,
} from "./token-estimator.js";
import { __resetModelCatalogForTests } from "../model-catalog.js";

afterEach(() => __resetModelCatalogForTests());

describe("contextInputTokens — per provider", () => {
  const usage = { promptTokens: 1_000, cacheReadTokens: 8_000, cacheWriteTokens: 500 };

  it("Anthropic reports cache reads/writes BESIDE input_tokens, so they are summed", () => {
    expect(contextInputTokens("anthropic", usage)).toBe(9_500);
  });

  it("OpenAI-compatible prompt_tokens already include cached tokens", () => {
    for (const p of ["local-gemma", "bedrock-gateway", "openai", "azure"]) {
      expect(contextInputTokens(p, usage)).toBe(1_000);
    }
  });

  it("nothing reported is null, never zero", () => {
    expect(contextInputTokens("anthropic", null)).toBeNull();
    expect(contextInputTokens("openai", { promptTokens: 0 })).toBeNull();
  });
});

describe("calibratedRatio", () => {
  it("is Σchars ÷ Σtokens over the recent samples", () => {
    expect(calibratedRatio([{ promptChars: 3_600, inputTokens: 1_000 }])).toBeCloseTo(3.6);
    expect(
      calibratedRatio([
        { promptChars: 1_000, inputTokens: 500 },
        { promptChars: 3_000, inputTokens: 500 },
      ]),
    ).toBeCloseTo(4);
  });

  it("uses only the most recent window of samples", () => {
    const old = Array.from({ length: 10 }, () => ({ promptChars: 1_000, inputTokens: 1_000 }));
    const recent = Array.from({ length: CALIBRATION_WINDOW }, () => ({
      promptChars: 4_000,
      inputTokens: 1_000,
    }));
    expect(calibratedRatio([...old, ...recent])).toBeCloseTo(4);
  });

  it("rejects no samples and implausible ratios", () => {
    expect(calibratedRatio([])).toBeNull();
    expect(calibratedRatio([{ promptChars: 0, inputTokens: 10 }])).toBeNull();
    expect(calibratedRatio([{ promptChars: 100, inputTokens: 1_000 }])).toBeNull();
    expect(calibratedRatio([{ promptChars: 100_000, inputTokens: 1_000 }])).toBeNull();
  });
});

describe("resolveTokenRatio — calibrated, then catalog, then default", () => {
  it("calibrated wins", () => {
    const r = resolveTokenRatio({
      provider: "local-gemma",
      model: "laguna-s-2.1",
      samples: [{ promptChars: 3_900, inputTokens: 1_000 }],
      env: {},
    });
    expect(r).toEqual({ charsPerToken: 3.9, source: "calibrated", samples: 1 });
  });

  it("the catalog's measured family ratio comes next (laguna 3.23)", () => {
    expect(resolveTokenRatio({ provider: "local-gemma", model: "laguna-s-2.1", env: {} })).toEqual({
      charsPerToken: 3.23,
      source: "catalog",
    });
  });

  it("an operator catalog override beats the family ratio", () => {
    const env = {
      AI_MODEL_CATALOG_OVERRIDES: JSON.stringify({
        "local-gemma:laguna-s-2.1": { charsPerToken: 3.7 },
      }),
    };
    expect(
      resolveTokenRatio({ provider: "local-gemma", model: "laguna-s-2.1", env }).charsPerToken,
    ).toBe(3.7);
  });

  it("an unmeasured model gets the conservative default", () => {
    expect(resolveTokenRatio({ provider: "anthropic", model: "claude-sonnet-5", env: {} })).toEqual(
      {
        charsPerToken: DEFAULT_CHARS_PER_TOKEN,
        source: "default",
      },
    );
  });
});

describe("estimates", () => {
  const ratio = { charsPerToken: 3, source: "default" as const };
  it("text and message estimates", () => {
    expect(estimateTextTokens("", ratio)).toBe(0);
    expect(estimateTextTokens("abcdefg", ratio)).toBe(3);
    expect(estimateCharTokens(0, ratio)).toBe(0);
    expect(estimateCharTokens(7, ratio)).toBe(3);
    expect(
      estimateMessagesTokens(
        [
          { role: "user", content: "abc" },
          { role: "assistant", content: "abcdef" },
        ],
        ratio,
      ),
    ).toBe(1 + 2 + 2 * MESSAGE_OVERHEAD_TOKENS);
    expect(
      promptChars([
        { role: "user", content: "abc" },
        { role: "system", content: "de" },
      ]),
    ).toBe(5);
  });
});

/*
 * #203 — the tolerance test against a fixture transcript now uses RECORDED
 * provider usage through the real adapters, not a synthetic tokenizer:
 * `server/tests/lib/ai/token-estimate-recorded-usage.test.ts`.
 */
