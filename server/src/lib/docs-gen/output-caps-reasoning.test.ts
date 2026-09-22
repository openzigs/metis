/**
 * #25 — docs-gen output caps on a THINKING-BY-DEFAULT model.
 *
 * A full-project Architecture document on `deepseek-v4-pro` came back with
 * three section groups truncated at 8,192 tokens. Two causes, both covered:
 *   1. the model was not in the ceiling table, so the section cap fell to the
 *      8,192 unknown-model default instead of the 32,768 answer budget;
 *   2. DeepSeek reasons by default and the reasoning is drawn from the same
 *      `max_tokens` as the answer, so even the answer budget was shared.
 * Pure functions — no DB, no network, no live model.
 */
import { describe, expect, it } from "vitest";
import type { ConfigService } from "../config/config-service.js";
import {
  DEFAULT_DB_SCHEMA_PROSE_MAX_OUTPUT_TOKENS,
  DEFAULT_FACTS_MAX_OUTPUT_TOKENS,
  DEFAULT_REASONING_ALLOWANCE_TOKENS,
  DEFAULT_SECTION_MAX_OUTPUT_TOKENS,
  modelOutputCeiling,
  modelThinksByDefault,
  reasoningAllowanceTokens,
  resolveDbSchemaProseMaxOutputTokens,
  resolveFactsMaxOutputTokens,
  resolveSectionMaxOutputTokens,
} from "./output-caps.js";

function stubConfig(values: Record<string, number> = {}): ConfigService {
  return {
    getNumber: (key: string, defaultValue?: number) => values[key] ?? defaultValue,
  } as unknown as ConfigService;
}

const DEEPSEEK_PRO = "deepseek-v4-pro";
const DEEPSEEK_FLASH = "deepseek-flash";
const CLAUDE_4 = "claude-sonnet-4-6";

describe("DeepSeek output ceiling (#25)", () => {
  it("knows DeepSeek V4's documented 384K (393,216) output ceiling", () => {
    expect(modelOutputCeiling(DEEPSEEK_PRO)).toBe(393_216);
    expect(modelOutputCeiling(DEEPSEEK_FLASH)).toBe(393_216);
    expect(modelOutputCeiling("deepseek-v4-flash")).toBe(393_216);
  });
});

describe("modelThinksByDefault (#25)", () => {
  it("is true only for models documented to reason by default", () => {
    expect(modelThinksByDefault(DEEPSEEK_PRO)).toBe(true);
    expect(modelThinksByDefault(DEEPSEEK_FLASH)).toBe(true);
    expect(modelThinksByDefault(CLAUDE_4)).toBe(false);
    expect(modelThinksByDefault("gemma3:4b")).toBe(false);
    expect(modelThinksByDefault(undefined)).toBe(false);
  });
});

describe("reasoning allowance on the docs-gen output caps (#25)", () => {
  it("gives a DeepSeek section the full answer budget PLUS reasoning headroom", () => {
    const cap = resolveSectionMaxOutputTokens(DEEPSEEK_PRO, stubConfig());
    // Before #25 this was 8,192 — the cap three section groups truncated at.
    expect(cap).toBe(DEFAULT_SECTION_MAX_OUTPUT_TOKENS + DEFAULT_REASONING_ALLOWANCE_TOKENS);
    expect(cap - DEFAULT_REASONING_ALLOWANCE_TOKENS).toBe(DEFAULT_SECTION_MAX_OUTPUT_TOKENS);
  });

  it("adds the same headroom to Phase-1 facts and DB-schema prose", () => {
    expect(resolveFactsMaxOutputTokens(DEEPSEEK_FLASH, stubConfig())).toBe(
      DEFAULT_FACTS_MAX_OUTPUT_TOKENS + DEFAULT_REASONING_ALLOWANCE_TOKENS,
    );
    expect(resolveDbSchemaProseMaxOutputTokens(DEEPSEEK_PRO, stubConfig())).toBe(
      DEFAULT_DB_SCHEMA_PROSE_MAX_OUTPUT_TOKENS + DEFAULT_REASONING_ALLOWANCE_TOKENS,
    );
  });

  it("treats an operator's section setting as the ANSWER budget", () => {
    const config = stubConfig({ DOCS_GEN_SECTION_MAX_OUTPUT_TOKENS: 50_000 });
    expect(resolveSectionMaxOutputTokens(DEEPSEEK_PRO, config)).toBe(
      50_000 + DEFAULT_REASONING_ALLOWANCE_TOKENS,
    );
  });

  it("honours a configured allowance, including 0 to opt out", () => {
    expect(
      resolveSectionMaxOutputTokens(
        DEEPSEEK_PRO,
        stubConfig({ DOCS_GEN_REASONING_ALLOWANCE_TOKENS: 10_000 }),
      ),
    ).toBe(DEFAULT_SECTION_MAX_OUTPUT_TOKENS + 10_000);
    expect(
      resolveSectionMaxOutputTokens(
        DEEPSEEK_PRO,
        stubConfig({ DOCS_GEN_REASONING_ALLOWANCE_TOKENS: 0 }),
      ),
    ).toBe(DEFAULT_SECTION_MAX_OUTPUT_TOKENS);
  });

  it("falls back to the default allowance on a negative setting", () => {
    expect(
      reasoningAllowanceTokens(
        DEEPSEEK_PRO,
        stubConfig({ DOCS_GEN_REASONING_ALLOWANCE_TOKENS: -5 }),
      ),
    ).toBe(DEFAULT_REASONING_ALLOWANCE_TOKENS);
  });

  it("still clamps the sum to the model's ceiling", () => {
    const config = stubConfig({ DOCS_GEN_SECTION_MAX_OUTPUT_TOKENS: 390_000 });
    expect(resolveSectionMaxOutputTokens(DEEPSEEK_PRO, config)).toBe(393_216);
  });

  it("leaves every model that does not think by default unchanged", () => {
    expect(reasoningAllowanceTokens(CLAUDE_4, stubConfig())).toBe(0);
    expect(resolveSectionMaxOutputTokens(CLAUDE_4, stubConfig())).toBe(
      DEFAULT_SECTION_MAX_OUTPUT_TOKENS,
    );
    // An unknown model keeps the conservative 8,192 unknown-model default.
    expect(resolveSectionMaxOutputTokens("some-local-gemma-27b", stubConfig())).toBe(8_192);
  });
});
