/**
 * #2569 — the code pass's dollar ceiling: how it reads its key, prices a call
 * from the ledger rates, refuses a call once the priced spend has reached it,
 * and what `runAgentLoop` does when its provider refuses (a turn, and the
 * final-answer retry the eval's cap let through).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatChunk, ChatOptions } from "../ai/types.js";
import { __resetConfigSingleton } from "../config/config-service.js";
import { runAgentLoop } from "./agent-loop.js";
import {
  CODE_PASS_MAX_USD_KEY,
  CodePassCostCeiling,
  CostCeilingReachedError,
  createCodePassCostCeiling,
  DEFAULT_CODE_PASS_MAX_USD,
  isCostCeilingReachedError,
  priceCallUsd,
  readCodePassMaxUsd,
} from "./code-pass-cost-ceiling.js";
import type { AgentTool } from "./tools/types.js";

const PRICED = { provider: "priced-stub", model: "stub-priced" };
/** $1 per million input and output tokens, so 50k + 50k tokens is $0.10. */
const PRICES = JSON.stringify({
  [`${PRICED.provider}:${PRICED.model}`]: { inputPerMTok: 1, outputPerMTok: 1 },
});
const TEN_CENTS = { promptTokens: 50_000, completionTokens: 50_000, totalTokens: 100_000 };

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  __resetConfigSingleton();
}

/** A provider whose every call costs $0.10 (or is unpriced), replying from `reply`. */
function stubProvider(
  reply: (call: number, opts?: ChatOptions) => string,
  ids: { provider: string; model: string } = PRICED,
) {
  const chat = vi.fn(async (_m: unknown, opts?: ChatOptions) => ({
    content: reply(chat.mock.calls.length - 1, opts),
    usage: { ...TEN_CENTS },
    model: ids.model,
    provider: ids.provider,
  }));
  async function* stream(): AsyncGenerator<ChatChunk> {
    yield { type: "delta", content: "hi" };
    yield { type: "usage", usage: { ...TEN_CENTS }, model: ids.model };
  }
  const provider = {
    key: ids.provider,
    model: ids.model,
    chat,
    stream: vi.fn(stream),
  } as unknown as AIProvider;
  return { provider, chat };
}

const lookTool: AgentTool = {
  name: "look",
  description: "look at something",
  parameters: { type: "object", properties: {} } as never,
  execute: async () => ({ content: "seen" }),
};
const TOOL_CALL = JSON.stringify({ tool: "look" });

beforeEach(() => setEnv("MODEL_PRICES", PRICES));
afterEach(() => {
  setEnv("MODEL_PRICES", undefined);
  setEnv(CODE_PASS_MAX_USD_KEY, undefined);
});

describe("readCodePassMaxUsd", () => {
  it("defaults to $1 per requirement", () => {
    expect(readCodePassMaxUsd()).toBe(DEFAULT_CODE_PASS_MAX_USD);
    expect(DEFAULT_CODE_PASS_MAX_USD).toBe(1);
  });

  it("reads a decimal, and 0 (off)", () => {
    setEnv(CODE_PASS_MAX_USD_KEY, "0.25");
    expect(readCodePassMaxUsd()).toBe(0.25);
    setEnv(CODE_PASS_MAX_USD_KEY, "0");
    expect(readCodePassMaxUsd()).toBe(0);
  });

  it("degrades a negative or a non-number from the environment to the default, never to off", () => {
    for (const bad of ["-1", "abc", "Infinity", " "]) {
      setEnv(CODE_PASS_MAX_USD_KEY, bad);
      expect(readCodePassMaxUsd()).toBe(DEFAULT_CODE_PASS_MAX_USD);
    }
  });
});

describe("priceCallUsd", () => {
  it("prices a call from the ledger rates (MODEL_PRICES here)", () => {
    expect(priceCallUsd(PRICED.provider, PRICED.model, TEN_CENTS)).toBeCloseTo(0.1, 10);
  });

  it("returns null, never 0, for a model with no ledger rate", () => {
    expect(priceCallUsd("unpriced-stub", "who-knows", TEN_CENTS)).toBeNull();
  });
});

describe("createCodePassCostCeiling", () => {
  it("scales the per-requirement ceiling with the requirements and the Continue multiplier", () => {
    setEnv(CODE_PASS_MAX_USD_KEY, "0.5");
    expect(createCodePassCostCeiling({ requirementCount: 4 }).limitUsd).toBe(2);
    expect(createCodePassCostCeiling({ requirementCount: 4, multiplier: 2 }).limitUsd).toBe(4);
    // A pass always has at least one requirement's worth.
    expect(createCodePassCostCeiling({ requirementCount: 0 }).limitUsd).toBe(0.5);
  });

  it("is off when the key is 0", () => {
    setEnv(CODE_PASS_MAX_USD_KEY, "0");
    expect(createCodePassCostCeiling({ requirementCount: 3 }).limitUsd).toBe(0);
  });
});

describe("CodePassCostCeiling.guard", () => {
  it("$0.10 calls under $0.25: three calls (the third starts at $0.20, ends at $0.30), the fourth refused", async () => {
    const { provider, chat } = stubProvider(() => "ok");
    const ceiling = new CodePassCostCeiling(0.25);
    const guarded = ceiling.guard(provider);
    for (let i = 0; i < 3; i++) await guarded.chat([{ role: "user", content: "q" }]);
    expect(ceiling.spentUsd).toBeCloseTo(0.3, 10);
    const refused = guarded.chat([{ role: "user", content: "q" }]);
    await expect(refused).rejects.toBeInstanceOf(CostCeilingReachedError);
    await expect(refused).rejects.toMatchObject({
      name: "CostCeilingReachedError",
      limitUsd: 0.25,
    });
    expect(chat).toHaveBeenCalledTimes(3);
    expect(ceiling.refusedCalls).toBe(1);
    expect(ceiling.outcome()).toEqual({
      limitUsd: 0.25,
      spentUsd: 0.3,
      reached: true,
      pricing: "priced",
    });
  });

  it("guards a stream too, and counts its usage chunk", async () => {
    const { provider } = stubProvider(() => "ok");
    const ceiling = new CodePassCostCeiling(0.15);
    const guarded = ceiling.guard(provider);
    const drain = async () => {
      for await (const _chunk of guarded.stream([{ role: "user", content: "q" }])) void _chunk;
    };
    await drain();
    await drain();
    expect(ceiling.spentUsd).toBeCloseTo(0.2, 10);
    await expect(drain()).rejects.toBeInstanceOf(CostCeilingReachedError);
  });

  it("passes every other member through to the adapter", () => {
    const { provider } = stubProvider(() => "ok");
    const guarded = new CodePassCostCeiling(1).guard(provider);
    expect(guarded.key).toBe(PRICED.provider);
    expect(guarded.model).toBe(PRICED.model);
  });

  it("a ceiling of 0 never refuses, and says nothing", async () => {
    const { provider, chat } = stubProvider(() => "ok");
    const ceiling = new CodePassCostCeiling(0);
    const guarded = ceiling.guard(provider);
    for (let i = 0; i < 12; i++) await guarded.chat([{ role: "user", content: "q" }]);
    expect(chat).toHaveBeenCalledTimes(12);
    expect(ceiling.outcome()).toBeNull();
  });

  it("an unpriced model is never $0: no refusal on unknown cost, and the outcome says cost-ceiling-unpriced", async () => {
    const { provider, chat } = stubProvider(() => "ok", {
      provider: "unpriced-stub",
      model: "who-knows",
    });
    const ceiling = new CodePassCostCeiling(0.25);
    const guarded = ceiling.guard(provider);
    for (let i = 0; i < 6; i++) await guarded.chat([{ role: "user", content: "q" }]);
    expect(chat).toHaveBeenCalledTimes(6);
    expect(ceiling.outcome()).toEqual({
      limitUsd: 0.25,
      spentUsd: 0,
      reached: false,
      pricing: "cost-ceiling-unpriced",
    });
  });

  it("an unpriced call does not lift a ceiling the priced spend has already reached", async () => {
    const ceiling = new CodePassCostCeiling(0.15);
    ceiling.record(PRICED.provider, PRICED.model, TEN_CENTS);
    ceiling.record(PRICED.provider, PRICED.model, TEN_CENTS);
    ceiling.record("unpriced-stub", "who-knows", TEN_CENTS);
    expect(() => ceiling.assertCanCall()).toThrow(CostCeilingReachedError);
    expect(ceiling.outcome()).toMatchObject({ reached: true, pricing: "cost-ceiling-unpriced" });
  });

  it("isCostCeilingReachedError tells the ceiling's refusal from any other error", () => {
    expect(isCostCeilingReachedError(new CostCeilingReachedError(1, 1))).toBe(true);
    expect(isCostCeilingReachedError(new Error("x"))).toBe(false);
  });
});

describe("runAgentLoop behind a guarded provider", () => {
  const retry = {
    instruction: "Answer now as JSON.",
    isValidFinalAnswer: (t: string) => t.trim().startsWith('{"findings"'),
  };

  it("stops at the ceiling: three model calls, the fourth turn and the final-answer retry refused", async () => {
    const { provider, chat } = stubProvider(() => TOOL_CALL);
    const ceiling = new CodePassCostCeiling(0.25);
    const result = await runAgentLoop(
      ceiling.guard(provider),
      { systemMessage: "sys", userMessage: "go", tools: [lookTool], toolContext: {} as never },
      { maxTurns: 10, finalAnswerRetry: retry },
    );
    expect(chat).toHaveBeenCalledTimes(3);
    expect(result.turnsUsed).toBe(3);
    expect(result.costCeilingReached).toBe(true);
    expect(result.hasFinalAnswer).toBe(false);
    expect(result.finalAnswerRetry).toMatchObject({ attempted: true, succeeded: false });
    // The fourth turn and the retry: both refused, neither reached the model.
    expect(ceiling.refusedCalls).toBe(2);
    expect(ceiling.spentUsd).toBeCloseTo(0.3, 10);
    expect(result.toolCalls).toHaveLength(3);
  });

  it("refuses the final-answer retry of a loop that ended on its turn cap past the ceiling", async () => {
    const { provider, chat } = stubProvider(() => TOOL_CALL);
    const ceiling = new CodePassCostCeiling(0.25);
    const result = await runAgentLoop(
      ceiling.guard(provider),
      { systemMessage: "sys", userMessage: "go", tools: [lookTool], toolContext: {} as never },
      { maxTurns: 3, finalAnswerRetry: retry },
    );
    expect(result.turnsExhausted).toBe(true);
    expect(result.finalAnswerRetry).toMatchObject({ attempted: true, succeeded: false });
    expect(chat).toHaveBeenCalledTimes(3);
    expect(ceiling.refusedCalls).toBe(1);
    expect(result.costCeilingReached).toBe(true);
  });

  it("without a ceiling the same loop spends every turn and the retry (the control)", async () => {
    const { provider, chat } = stubProvider(() => TOOL_CALL);
    const result = await runAgentLoop(
      new CodePassCostCeiling(0).guard(provider),
      { systemMessage: "sys", userMessage: "go", tools: [lookTool], toolContext: {} as never },
      { maxTurns: 10, finalAnswerRetry: retry },
    );
    expect(chat).toHaveBeenCalledTimes(11);
    expect(result.costCeilingReached).toBeUndefined();
  });

  it("a ceiling reached before the first call ends the loop with no turn used and no retry", async () => {
    const { provider, chat } = stubProvider(() => TOOL_CALL);
    const ceiling = new CodePassCostCeiling(0.05);
    ceiling.record(PRICED.provider, PRICED.model, TEN_CENTS);
    const result = await runAgentLoop(
      ceiling.guard(provider),
      { systemMessage: "sys", userMessage: "go", tools: [lookTool], toolContext: {} as never },
      { maxTurns: 10, finalAnswerRetry: retry },
    );
    expect(chat).not.toHaveBeenCalled();
    expect(result.turnsUsed).toBe(0);
    expect(result.costCeilingReached).toBe(true);
    expect(result.finalAnswerRetry).toBeUndefined();
  });

  it("any other provider error still fails the loop", async () => {
    const provider = {
      key: "x",
      model: "y",
      chat: vi.fn(async () => {
        throw new Error("upstream 500");
      }),
    } as unknown as AIProvider;
    await expect(
      runAgentLoop(
        provider,
        { systemMessage: "sys", userMessage: "go", tools: [lookTool], toolContext: {} as never },
        { maxTurns: 3 },
      ),
    ).rejects.toThrow("upstream 500");
  });
});
