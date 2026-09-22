/**
 * #22 — ONE pricing source feeds BOTH usage tables.
 *
 * A single provider call is written to `token_usages` (finops `recordUsage`,
 * integer cents) AND to `ai_token_usages` (`TokenTracker`, USD). Before #22
 * the two priced from different tables and disagreed in opposite directions
 * for a model neither knew: `token_usages` billed `deepseek-v4-pro` at Claude
 * Sonnet 4.6 rates, `ai_token_usages` recorded it at 0. This suite drives the
 * SAME call through both write paths and reads back what each persisted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tokenUsageCreate = vi.fn(async (_: unknown) => ({}));
const aiTokenUsageCreate = vi.fn(async (_: unknown) => ({}));

vi.mock("../prisma.js", () => ({
  prisma: {
    tokenUsage: { create: (a: unknown) => tokenUsageCreate(a) },
    aITokenUsage: { create: (a: unknown) => aiTokenUsageCreate(a) },
  },
}));

import { recordUsageAndFlush } from "./token-tracker.js";
import { TokenTracker } from "../ai/token-tracker.js";

type Call = {
  provider: "anthropic" | "bedrock-gateway";
  model: string;
  input: number;
  output: number;
};

/** Write one call through both paths; return what each table received. */
async function writeBoth(call: Call): Promise<{ costCents: unknown; estimatedCostUsd: unknown }> {
  tokenUsageCreate.mockClear();
  aiTokenUsageCreate.mockClear();
  await recordUsageAndFlush({
    projectId: "p-1",
    sessionId: "s-1",
    provider: call.provider,
    model: call.model,
    inputTokens: call.input,
    outputTokens: call.output,
  });
  await new TokenTracker().recordAndFlush({
    sessionId: "s-1",
    userId: "u-1",
    provider: call.provider,
    model: call.model,
    usage: { promptTokens: call.input, completionTokens: call.output },
  });
  const tu = tokenUsageCreate.mock.calls[0]?.[0] as { data: { costCents: unknown } };
  const ai = aiTokenUsageCreate.mock.calls[0]?.[0] as { data: { estimatedCostUsd: unknown } };
  return { costCents: tu.data.costCents, estimatedCostUsd: ai.data.estimatedCostUsd };
}

describe("#22 — both usage tables price from one source", () => {
  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_BASE_URL", "");
    vi.stubEnv("MODEL_PRICES", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("records the #22 DeepSeek run as UNPRICED (null) in BOTH tables", async () => {
    // Measured in #22: token_usages said 2,349 cents (Sonnet rates),
    // ai_token_usages said 0, for the same model.
    const r = await writeBoth({
      provider: "anthropic",
      model: "deepseek-v4-pro",
      input: 1_334_017,
      output: 1_297_372,
    });
    expect(r.costCents).toBeNull();
    expect(r.estimatedCostUsd).toBeNull();
  });

  it("agrees on a priced model (same number, cents vs USD)", async () => {
    const r = await writeBoth({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      input: 1_000_000,
      output: 1_000_000,
    });
    expect(r.costCents).toBe(1800);
    expect(r.estimatedCostUsd).toBeCloseTo(18, 10);
  });

  it("agrees on Opus 4.8 — the two old tables priced it $5/$25 vs $15/$75", async () => {
    const r = await writeBoth({
      provider: "bedrock-gateway",
      model: "us.anthropic.claude-opus-4-8",
      input: 1_000_000,
      output: 1_000_000,
    });
    expect(r.costCents).toBe(3000);
    expect(r.estimatedCostUsd).toBeCloseTo(30, 10);
  });

  it("applies an administrator's MODEL_PRICES to both tables", async () => {
    vi.stubEnv(
      "MODEL_PRICES",
      JSON.stringify({ "deepseek-v4-pro": { inputPerMTok: 1.32, outputPerMTok: 3.96 } }),
    );
    const r = await writeBoth({
      provider: "anthropic",
      model: "deepseek-v4-pro",
      input: 1_000_000,
      output: 1_000_000,
    });
    expect(r.costCents).toBe(528);
    expect(r.estimatedCostUsd).toBeCloseTo(5.28, 10);
  });

  it("does not price a claude-* name at Anthropic rates behind a third-party endpoint", async () => {
    // DeepSeek maps claude-haiku-* onto its own deepseek-flash.
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://api.deepseek.com/anthropic");
    const r = await writeBoth({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      input: 1000,
      output: 1000,
    });
    expect(r.costCents).toBeNull();
    expect(r.estimatedCostUsd).toBeNull();
  });
});
