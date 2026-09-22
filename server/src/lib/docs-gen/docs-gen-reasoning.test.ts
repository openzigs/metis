/**
 * #25 (follow-up to #41) — bound the REASONING a thinking-by-default model spends
 * on Phase-1 fact extraction.
 *
 * After #41 raised the per-call output budget, `deepseek-v4-pro` spent ~19,800
 * output tokens and ~88 s per Phase-1 module (vs ~7,700 / ~23 s): the headroom
 * went to reasoning, not to facts. Phase 1 is mechanical extraction, so the
 * resolver asks such a model for LOW effort by default — and changes nothing
 * for a model that does not reason by default (Claude on api.anthropic.com).
 * Pure function — no DB, no network, no live model.
 */
import { describe, expect, it } from "vitest";
import type { ConfigService } from "../config/config-service.js";
import {
  DEFAULT_THINKING_MODEL_PHASE1_EFFORT,
  resolvePhase1Reasoning,
} from "./docs-gen-reasoning.js";

function stubConfig(values: Record<string, string> = {}): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

const NO_ENV = {};
const DEEPSEEK_ENDPOINT = { ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic" };

describe("resolvePhase1Reasoning (#25)", () => {
  it("bounds a thinking-by-default model to low effort when unset", () => {
    expect(DEFAULT_THINKING_MODEL_PHASE1_EFFORT).toBe("low");
    expect(resolvePhase1Reasoning("deepseek-v4-pro", stubConfig(), NO_ENV)).toEqual({
      reasoningEffort: "low",
    });
    expect(resolvePhase1Reasoning("deepseek-flash", stubConfig(), NO_ENV)).toEqual({
      reasoningEffort: "low",
    });
  });

  it("bounds a claude-* name served by DeepSeek's Anthropic endpoint", () => {
    expect(resolvePhase1Reasoning("claude-opus-4-8", stubConfig(), DEEPSEEK_ENDPOINT)).toEqual({
      reasoningEffort: "low",
    });
  });

  it("sends nothing for Claude on Anthropic — behaviour unchanged", () => {
    expect(resolvePhase1Reasoning("claude-sonnet-4-6", stubConfig(), NO_ENV)).toEqual({});
    expect(
      resolvePhase1Reasoning("claude-sonnet-4-6", stubConfig(), {
        ANTHROPIC_BASE_URL: "https://gateway.example.com",
      }),
    ).toEqual({});
    expect(resolvePhase1Reasoning("us.anthropic.claude-sonnet-4-6", stubConfig(), NO_ENV)).toEqual(
      {},
    );
    expect(resolvePhase1Reasoning(undefined, stubConfig(), NO_ENV)).toEqual({});
  });

  it("'auto' is the same as unset", () => {
    const cfg = stubConfig({ DOCS_GEN_PHASE1_REASONING: "auto" });
    expect(resolvePhase1Reasoning("deepseek-v4-pro", cfg, NO_ENV)).toEqual({
      reasoningEffort: "low",
    });
    expect(resolvePhase1Reasoning("claude-sonnet-4-6", cfg, NO_ENV)).toEqual({});
  });

  it("'off' disables thinking", () => {
    const cfg = stubConfig({ DOCS_GEN_PHASE1_REASONING: "off" });
    expect(resolvePhase1Reasoning("deepseek-v4-pro", cfg, NO_ENV)).toEqual({
      disableThinking: true,
    });
  });

  it("'provider-default' sends nothing, even for a thinking model", () => {
    const cfg = stubConfig({ DOCS_GEN_PHASE1_REASONING: "provider-default" });
    expect(resolvePhase1Reasoning("deepseek-v4-pro", cfg, NO_ENV)).toEqual({});
  });

  it("an explicit effort applies to any model (operator's choice)", () => {
    const cfg = stubConfig({ DOCS_GEN_PHASE1_REASONING: "high" });
    expect(resolvePhase1Reasoning("deepseek-v4-pro", cfg, NO_ENV)).toEqual({
      reasoningEffort: "high",
    });
    expect(resolvePhase1Reasoning("claude-sonnet-4-6", cfg, NO_ENV)).toEqual({
      reasoningEffort: "high",
    });
    expect(
      resolvePhase1Reasoning(
        "deepseek-v4-pro",
        stubConfig({ DOCS_GEN_PHASE1_REASONING: " Medium " }),
        NO_ENV,
      ),
    ).toEqual({ reasoningEffort: "medium" });
  });

  it("an unrecognised value falls back to auto", () => {
    const cfg = stubConfig({ DOCS_GEN_PHASE1_REASONING: "ultra" });
    expect(resolvePhase1Reasoning("deepseek-v4-pro", cfg, NO_ENV)).toEqual({
      reasoningEffort: "low",
    });
    expect(resolvePhase1Reasoning("claude-sonnet-4-6", cfg, NO_ENV)).toEqual({});
  });
});
