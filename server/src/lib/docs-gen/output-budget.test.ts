/**
 * #1132 — an output cap is stated as its answer budget and reasoning allowance.
 *
 * Run 8 recorded `max_tokens` 49,152 against
 * `DOCS_GEN_SECTION_MAX_OUTPUT_TOKENS=16384`: the setting had been applied, and
 * 32,768 of reasoning added on top, but nothing said so.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigService } from "../config/config-service.js";
import {
  describeOutputBudget,
  resolveDocsGenOutputBudget,
  resolveSectionMaxOutputTokens,
  resolveSectionOutputBudget,
} from "./output-caps.js";
import { batchTruncatedWarning, sectionTruncatedWarning } from "./grounding/degraded-warnings.js";

// A `claude-*` name sent to DeepSeek's endpoint reasons; this file means real Claude.
beforeEach(() => vi.stubEnv("ANTHROPIC_BASE_URL", ""));
afterEach(() => vi.unstubAllEnvs());

const config = (values: Record<string, number> = {}): ConfigService =>
  ({ getNumber: (key: string, d?: number) => values[key] ?? d }) as unknown as ConfigService;

describe("#1132 — resolveSectionOutputBudget", () => {
  it("keeps run 8's answer budget and reasoning allowance apart", () => {
    const budget = resolveSectionOutputBudget(
      "deepseek-flash",
      config({ DOCS_GEN_SECTION_MAX_OUTPUT_TOKENS: 16_384 }),
    );
    expect(budget).toEqual({
      maxTokens: 49_152,
      answer: 16_384,
      reasoning: 32_768,
      ceiling: 393_216,
    });
    expect(describeOutputBudget(budget)).toBe("49,152 tokens (answer 16,384 + reasoning 32,768)");
  });

  it("sends exactly the cap it describes", () => {
    const cfg = config({ DOCS_GEN_SECTION_MAX_OUTPUT_TOKENS: 16_384 });
    for (const model of ["deepseek-flash", "claude-sonnet-4-6", "gemma3:4b", undefined]) {
      expect(resolveSectionOutputBudget(model, cfg).maxTokens).toBe(
        resolveSectionMaxOutputTokens(model, cfg),
      );
    }
  });

  it("says a model's ceiling lowered the sum", () => {
    const budget = resolveDocsGenOutputBudget(
      "DOCS_GEN_SECTION_MAX_OUTPUT_TOKENS",
      32_768,
      "claude-3-5-haiku",
      config(),
    );
    expect(budget).toMatchObject({ maxTokens: 8_192, answer: 32_768, reasoning: 0 });
    expect(describeOutputBudget(budget)).toBe(
      "8,192 tokens (answer 32,768, no reasoning, lowered to the model's 8,192 maximum)",
    );
  });

  it("names a model with no reasoning allowance plainly", () => {
    const budget = resolveSectionOutputBudget("gemma3:4b", config());
    expect(describeOutputBudget(budget)).toBe("8,192 tokens (answer 8,192, no reasoning)");
  });
});

describe("#1132 — the section-truncated warnings name both parts", () => {
  const run8 = { maxTokens: 49_152, answer: 16_384, reasoning: 32_768, ceiling: 393_216 };

  it("sectionTruncatedWarning", () => {
    const w = sectionTruncatedWarning("Component Breakdown", "sig", run8);
    expect(w.message).toContain("49,152 tokens (answer 16,384 + reasoning 32,768)");
    expect(w.message).toContain("DOCS_GEN_SECTION_MAX_OUTPUT_TOKENS (the answer budget)");
    expect(w.message).not.toContain("undefined");
  });

  it("batchTruncatedWarning", () => {
    const w = batchTruncatedWarning(
      "Business Rules",
      { singleModules: ["m"], allowanceSpent: [], runaway: [] },
      run8,
    );
    expect(w.kind).toBe("section-truncated");
    expect(w.message).toContain("answer 16,384 + reasoning 32,768");
    expect(w.message).toContain("(the answer budget)");
  });

  it("a bare number still reads as before", () => {
    expect(sectionTruncatedWarning("X", "sig", 8192).message).toContain("8192 tokens");
    const w = batchTruncatedWarning(
      "B",
      { singleModules: ["m"], allowanceSpent: [], runaway: [] },
      8192,
    );
    expect(w.message).toContain("(8192 tokens)");
    expect(w.message).not.toContain("answer budget");
  });
});
