/**
 * #152 — claim extraction has its own OUTPUT cap, DOCS_GEN_CLAIM_MAX_OUTPUT_TOKENS,
 * instead of reusing the section cap. Pure functions — no DB, no network.
 */
import { describe, expect, it } from "vitest";
import type { ConfigService } from "../config/config-service.js";
import { getKeyDef } from "../config/key-registry.js";
import {
  DEFAULT_CLAIM_MAX_OUTPUT_TOKENS,
  DEFAULT_REASONING_ALLOWANCE_TOKENS,
  resolveClaimMaxOutputTokens,
} from "./output-caps.js";

function stubConfig(values: Record<string, number> = {}): ConfigService {
  return {
    getNumber: (key: string, defaultValue?: number) => values[key] ?? defaultValue,
  } as unknown as ConfigService;
}

const CLAIM_KEY = "DOCS_GEN_CLAIM_MAX_OUTPUT_TOKENS";
const SECTION_KEY = "DOCS_GEN_SECTION_MAX_OUTPUT_TOKENS";
const CLAUDE_4 = "claude-sonnet-4-6";
const HAIKU_35 = "us.anthropic.claude-3-5-haiku-20241022-v1:0";

describe("resolveClaimMaxOutputTokens (#152)", () => {
  it("defaults to its own value on a model known to allow it", () => {
    expect(resolveClaimMaxOutputTokens(CLAUDE_4, stubConfig())).toBe(
      DEFAULT_CLAIM_MAX_OUTPUT_TOKENS,
    );
  });

  it("reads its own key and ignores the section cap", () => {
    expect(resolveClaimMaxOutputTokens(CLAUDE_4, stubConfig({ [SECTION_KEY]: 40_000 }))).toBe(
      DEFAULT_CLAIM_MAX_OUTPUT_TOKENS,
    );
    expect(
      resolveClaimMaxOutputTokens(
        CLAUDE_4,
        stubConfig({ [SECTION_KEY]: 40_000, [CLAIM_KEY]: 12_000 }),
      ),
    ).toBe(12_000);
  });

  it("falls back to 8192 for an unknown (local) model, but honours an explicit setting", () => {
    expect(resolveClaimMaxOutputTokens("gemma3:12b", stubConfig())).toBe(8192);
    expect(resolveClaimMaxOutputTokens("gemma3:12b", stubConfig({ [CLAIM_KEY]: 20_000 }))).toBe(
      20_000,
    );
  });

  it("clamps to the claim model's ceiling", () => {
    expect(resolveClaimMaxOutputTokens(HAIKU_35, stubConfig({ [CLAIM_KEY]: 30_000 }))).toBe(8192);
  });

  it("adds the reasoning allowance for a thinking-by-default model", () => {
    expect(resolveClaimMaxOutputTokens("deepseek-v4-pro", stubConfig())).toBe(
      DEFAULT_CLAIM_MAX_OUTPUT_TOKENS + DEFAULT_REASONING_ALLOWANCE_TOKENS,
    );
  });

  it("is a registered tunable, so the admin settings page can change it", () => {
    const entry = getKeyDef(CLAIM_KEY)!;
    expect(entry.tier).toBe("tunable");
    expect(entry.valueType).toBe("int");
    expect(entry.schema.safeParse("16384").success).toBe(true);
    expect(entry.schema.safeParse("0").success).toBe(false);
  });
});
