/**
 * #718 — scanner OUTPUT caps on a THINKING-BY-DEFAULT model.
 *
 * On DeepSeek (`deepseek-flash`) a 2,048-token per-symbol cap can be spent
 * entirely on reasoning, leaving empty `content` — and the bug scan failed on
 * "no JSON object/array found in model output". Pure function, no network.
 */
import { describe, expect, it } from "vitest";
import type { ConfigService } from "../config/config-service.js";
import { DEFAULT_REASONING_ALLOWANCE_TOKENS } from "../docs-gen/output-caps.js";
import { scannerMaxOutputTokens } from "./output-budget.js";

function stubConfig(values: Record<string, number> = {}): ConfigService {
  return {
    getNumber: (key: string, defaultValue?: number) => values[key] ?? defaultValue,
  } as unknown as ConfigService;
}

const noBaseUrl = {};

describe("scannerMaxOutputTokens (#718)", () => {
  it("adds the reasoning allowance for a model that reasons by default", () => {
    expect(scannerMaxOutputTokens(2048, "deepseek-flash", stubConfig(), noBaseUrl)).toBe(
      2048 + DEFAULT_REASONING_ALLOWANCE_TOKENS,
    );
  });

  it("honours the operator's DOCS_GEN_REASONING_ALLOWANCE_TOKENS setting", () => {
    const config = stubConfig({ DOCS_GEN_REASONING_ALLOWANCE_TOKENS: 4000 });
    expect(scannerMaxOutputTokens(512, "deepseek-flash", config, noBaseUrl)).toBe(4512);
  });

  it("adds it for a claude-* name served by DeepSeek's Anthropic endpoint", () => {
    const env = { ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic" };
    expect(scannerMaxOutputTokens(2048, "claude-haiku-4-5", stubConfig(), env)).toBe(
      2048 + DEFAULT_REASONING_ALLOWANCE_TOKENS,
    );
  });

  it("leaves real Claude and unknown models at the answer budget", () => {
    expect(scannerMaxOutputTokens(2048, "claude-haiku-4-5", stubConfig(), noBaseUrl)).toBe(2048);
    expect(scannerMaxOutputTokens(512, "gemma3:4b", stubConfig(), noBaseUrl)).toBe(512);
    expect(scannerMaxOutputTokens(512, undefined, stubConfig(), noBaseUrl)).toBe(512);
  });

  it("clamps to the model's known output ceiling", () => {
    const config = stubConfig({ DOCS_GEN_REASONING_ALLOWANCE_TOKENS: 1_000_000 });
    expect(scannerMaxOutputTokens(2048, "deepseek-flash", config, noBaseUrl)).toBe(393_216);
    // A small-window model is never handed more than it accepts.
    expect(scannerMaxOutputTokens(8192, "claude-3-haiku", stubConfig(), noBaseUrl)).toBe(4096);
  });
});
