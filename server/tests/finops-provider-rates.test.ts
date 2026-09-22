/**
 * Unit tests for the FinOps rate map + cost computation (Epic #164).
 */
import { describe, it, expect } from "vitest";
import {
  computeCostCents,
  DEFAULT_RATE,
  getRate,
  __testRateKeys,
} from "../src/lib/finops/provider-rates.js";

describe("getRate", () => {
  it("returns exact provider:model match when present", () => {
    const r = getRate("openai", "gpt-4o");
    expect(r.inputPer1k).toBe(0.25);
    expect(r.outputPer1k).toBe(1.0);
  });

  it("supports Bedrock-hosted Claude with cache rates", () => {
    const r = getRate("bedrock-gateway", "anthropic.claude-3-5-sonnet-20241022-v2:0");
    expect(r.cacheReadPer1k).toBe(0.03);
    expect(r.cacheWritePer1k).toBe(0.375);
  });

  it("falls back to provider:default for a free internal provider when model is unknown", () => {
    const r = getRate("offline-stub", "totally-made-up-model");
    expect(r).toBe(DEFAULT_RATE);
  });

  it("returns null (UNPRICED) for completely unknown providers, not a zero rate (#22)", () => {
    expect(getRate("nope", "nope")).toBeNull();
  });

  it("registry contains the marquee models", () => {
    const keys = __testRateKeys();
    expect(keys).toContain("openai:gpt-4o");
    expect(keys).toContain("openai:gpt-4o-mini");
    expect(keys).toContain("anthropic:claude-3-5-sonnet");
    expect(keys).toContain("azure:gpt-4o");
    expect(keys).toContain("copilot-native:default");
    expect(keys).toContain("offline-stub:default");
  });
});

describe("computeCostCents", () => {
  it("adds input + output token costs and rounds to integer cents", () => {
    const rate = { inputPer1k: 0.25, outputPer1k: 1.0 };
    // 4000 input * 0.25/1k = 1c, 1000 output * 1.0/1k = 1c → 2c
    expect(computeCostCents(rate, { inputTokens: 4000, outputTokens: 1000 })).toBe(2);
  });

  it("uses cache rates when provided", () => {
    const rate = {
      inputPer1k: 1,
      outputPer1k: 2,
      cacheReadPer1k: 0.1,
      cacheWritePer1k: 1.5,
    };
    // 1000 cacheRead * 0.1/1k = 0.1c, 1000 cacheWrite * 1.5/1k = 1.5c → 2c (rounded from 1.6)
    expect(
      computeCostCents(rate, {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 1000,
        cacheWriteTokens: 1000,
      }),
    ).toBe(2);
  });

  it("falls back to input rate when cache rates are absent", () => {
    const rate = { inputPer1k: 1.0, outputPer1k: 1.0 };
    // 1000 cacheRead → 1c, 1000 cacheWrite → 1c
    expect(
      computeCostCents(rate, {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 1000,
        cacheWriteTokens: 1000,
      }),
    ).toBe(2);
  });

  it("returns zero for zero usage", () => {
    expect(computeCostCents(DEFAULT_RATE, { inputTokens: 0, outputTokens: 0 })).toBe(0);
  });
});
