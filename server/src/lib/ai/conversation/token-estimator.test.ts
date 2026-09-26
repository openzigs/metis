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

/**
 * #137 AC — "a test shows the estimate within a stated tolerance on a fixture
 * transcript". No recorded provider usage for chat exists in this repository and
 * no tokenizer ships with it, so the fixture's ground truth is a SYNTHETIC
 * tokenizer (a fixed 3.8 chars/token, a real measured Markdown-ish figure) —
 * this proves the calibration arithmetic, not any vendor's tokenizer.
 *
 * Stated tolerance: after one reported turn the estimate is within ±10% of the
 * truth; before any report (default ratio) it may over-count but never
 * under-counts by more than 5%, because under-counting is what overflows.
 */
describe("fixture transcript — estimate within tolerance", () => {
  const TRUE_CHARS_PER_TOKEN = 3.8;
  const turns = [
    "Which batch jobs feed the nightly reconciliation, and in what order do they run?",
    "Three jobs: ExtractLedger (01:00), NormaliseFx (01:30) and Reconcile (02:00). Reconcile waits on both via the scheduler's dependency table; see scheduler/jobs.yaml lines 40-88.",
    "What happens if NormaliseFx fails?",
    "Reconcile is skipped and an alert fires; the ledger extract is kept so a manual rerun only repeats FX normalisation. The retry policy is 3 attempts, 10 minutes apart.",
  ].map((content, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content,
  }));
  const truth = (chars: number) => Math.ceil(chars / TRUE_CHARS_PER_TOKEN);

  it("after one reported turn the estimate is within ±10%", () => {
    const firstPrompt = turns.slice(0, 1);
    const sample = {
      promptChars: promptChars(firstPrompt),
      inputTokens: truth(promptChars(firstPrompt)),
    };
    const ratio = resolveTokenRatio({
      provider: "openai",
      model: "gpt-4o",
      samples: [sample],
      env: {},
    });
    const chars = promptChars(turns);
    const est = estimateTextTokens("x".repeat(chars), ratio);
    expect(Math.abs(est - truth(chars)) / truth(chars)).toBeLessThanOrEqual(0.1);
  });

  it("before any report the default never under-counts by more than 5%", () => {
    const ratio = resolveTokenRatio({ provider: "openai", model: "gpt-4o", env: {} });
    const chars = promptChars(turns);
    const est = estimateTextTokens("x".repeat(chars), ratio);
    expect(est).toBeGreaterThanOrEqual(truth(chars) * 0.95);
  });
});
