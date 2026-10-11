/**
 * #1057 — the explicit output cap and reasoning effort every Spec Kit call
 * sends. Pure functions: a stub ConfigService, no DB, no network.
 */
import { describe, expect, it } from "vitest";
import type { ConfigService } from "../config/config-service.js";
import {
  DEFAULT_SPEC_KIT_MAX_OUTPUT_TOKENS,
  resolveSpecKitMaxOutputTokens,
  resolveSpecKitOutputOptions,
} from "./output-budget.js";

function stubConfig(values: Record<string, string> = {}): ConfigService {
  return {
    get: (key: string) => values[key],
    getNumber: (key: string, fallback?: number) =>
      values[key] === undefined ? (fallback ?? NaN) : Number(values[key]),
  } as unknown as ConfigService;
}

const NO_ENV = {};

describe("resolveSpecKitMaxOutputTokens (#1057)", () => {
  it("defaults to the SDK non-streaming bound for a model with a known ceiling", () => {
    expect(DEFAULT_SPEC_KIT_MAX_OUTPUT_TOKENS).toBe(21_333);
    expect(resolveSpecKitMaxOutputTokens("claude-sonnet-4-6", stubConfig())).toBe(21_333);
    expect(resolveSpecKitMaxOutputTokens("deepseek-flash", stubConfig())).toBe(21_333);
  });

  it("clamps to a smaller model ceiling", () => {
    expect(resolveSpecKitMaxOutputTokens("claude-3-5-haiku", stubConfig())).toBe(8_192);
    expect(
      resolveSpecKitMaxOutputTokens(
        "claude-3-haiku",
        stubConfig({ SPEC_KIT_MAX_OUTPUT_TOKENS: "20000" }),
      ),
    ).toBe(4_096);
  });

  it("gives an unknown model the safe default unless the operator set a value", () => {
    expect(resolveSpecKitMaxOutputTokens("laguna-s-2.1", stubConfig())).toBe(8_192);
    expect(resolveSpecKitMaxOutputTokens(undefined, stubConfig())).toBe(8_192);
    expect(
      resolveSpecKitMaxOutputTokens(
        "laguna-s-2.1",
        stubConfig({ SPEC_KIT_MAX_OUTPUT_TOKENS: "30000" }),
      ),
    ).toBe(30_000);
  });

  it("honours a configured value and rejects an unusable one", () => {
    const at = (v: string) =>
      resolveSpecKitMaxOutputTokens(
        "claude-sonnet-4-6",
        stubConfig({ SPEC_KIT_MAX_OUTPUT_TOKENS: v }),
      );
    expect(at("12000")).toBe(12_000);
    expect(at("12000.7")).toBe(12_000);
    expect(at("512")).toBe(512);
    expect(at("511")).toBe(21_333);
    expect(at("abc")).toBe(21_333);
  });
});

describe("resolveSpecKitOutputOptions (#1057)", () => {
  it("auto: low effort for a thinking-by-default model", () => {
    expect(resolveSpecKitOutputOptions("deepseek-flash", stubConfig(), NO_ENV)).toEqual({
      maxTokens: 21_333,
      reasoningEffort: "low",
    });
    expect(
      resolveSpecKitOutputOptions("claude-sonnet-4-6", stubConfig(), {
        ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
      }),
    ).toMatchObject({ reasoningEffort: "low" });
  });

  it("auto: no reasoning option for Claude on Anthropic", () => {
    expect(resolveSpecKitOutputOptions("claude-sonnet-4-6", stubConfig(), NO_ENV)).toEqual({
      maxTokens: 21_333,
    });
  });

  it("reads SPEC_KIT_REASONING, not the docs-gen key", () => {
    expect(
      resolveSpecKitOutputOptions(
        "deepseek-flash",
        stubConfig({ SPEC_KIT_REASONING: "off", DOCS_GEN_PHASE1_REASONING: "high" }),
        NO_ENV,
      ),
    ).toEqual({ maxTokens: 21_333, disableThinking: true });
    expect(
      resolveSpecKitOutputOptions(
        "claude-sonnet-4-6",
        stubConfig({ SPEC_KIT_REASONING: "medium" }),
        NO_ENV,
      ),
    ).toMatchObject({ reasoningEffort: "medium" });
    expect(
      resolveSpecKitOutputOptions(
        "deepseek-flash",
        stubConfig({ SPEC_KIT_REASONING: "provider-default" }),
        NO_ENV,
      ),
    ).toEqual({ maxTokens: 21_333 });
  });
});
