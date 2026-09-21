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
    expect(res).toEqual({ raw: '{"verdicts":[]}', promptTokens: 11, completionTokens: 7 });
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
});
