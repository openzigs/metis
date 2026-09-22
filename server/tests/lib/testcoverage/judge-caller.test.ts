/**
 * Tests for the provider-backed JudgeModelCaller (Epic #880 issue #886).
 */
import { describe, it, expect, vi } from "vitest";
import { createProviderJudgeCaller } from "../../../src/lib/testcoverage/judge-caller.js";
import type { AIProvider } from "../../../src/lib/ai/types.js";

function makeProvider(overrides: Partial<AIProvider> = {}): AIProvider {
  return {
    key: "offline-stub",
    model: "stub-model",
    offline: true,
    chat: vi.fn().mockResolvedValue({
      content: '{"verdicts":[]}',
      usage: { promptTokens: 11, completionTokens: 7, totalTokens: 18 },
      model: "stub-model",
      provider: "offline-stub",
    }),
    stream: vi.fn(),
    embed: vi.fn(),
    models: vi.fn(),
    ping: vi.fn(),
    ...overrides,
  } as unknown as AIProvider;
}

describe("createProviderJudgeCaller", () => {
  it("calls the provider with a tool-free user message + system prompt", async () => {
    const provider = makeProvider();
    const caller = createProviderJudgeCaller(provider);
    const res = await caller.call({
      modelId: "haiku",
      systemPrompt: "you are a judge",
      userPrompt: "judge this",
    });

    expect(provider.chat).toHaveBeenCalledWith(
      [{ role: "user", content: "judge this" }],
      expect.objectContaining({
        model: "haiku",
        systemMessage: "you are a judge",
        disableTools: true,
      }),
    );
    expect(res).toEqual({
      raw: '{"verdicts":[]}',
      promptTokens: 11,
      completionTokens: 7,
      provider: "offline-stub",
      model: "stub-model",
    });
  });

  it("propagates token usage from the chat response", async () => {
    const provider = makeProvider({
      chat: vi.fn().mockResolvedValue({
        content: "raw-json",
        usage: { promptTokens: 100, completionTokens: 42, totalTokens: 142 },
        model: "m",
        provider: "offline-stub",
      }),
    });
    const caller = createProviderJudgeCaller(provider);
    const res = await caller.call({ modelId: "m", systemPrompt: "s", userPrompt: "u" });
    expect(res.promptTokens).toBe(100);
    expect(res.completionTokens).toBe(42);
    expect(res.raw).toBe("raw-json");
  });

  it("reports what served the call, not what was requested (#43)", async () => {
    // An Anthropic-compatible endpoint (DeepSeek) serves `claude-haiku-*` as its
    // own model; usage must be recorded and priced under what it reports.
    const provider = makeProvider({
      key: "anthropic",
      chat: vi.fn().mockResolvedValue({
        content: "{}",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: "deepseek-flash",
        provider: "anthropic",
      }),
    });
    const res = await createProviderJudgeCaller(provider).call({
      modelId: "claude-haiku-4-5",
      systemPrompt: "s",
      userPrompt: "u",
    });
    expect(res.provider).toBe("anthropic");
    expect(res.model).toBe("deepseek-flash");
  });
});
