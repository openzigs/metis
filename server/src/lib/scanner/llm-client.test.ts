/** Epic #708 — llm-client extractJson + callJsonLlm tests. */
import { describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatMessage, ChatResponse } from "../ai/types.js";
import { callJsonLlm, extractJson } from "./llm-client.js";

function makeProvider(content: string): AIProvider {
  const response: ChatResponse = {
    role: "assistant",
    content,
    finishReason: "stop",
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    model: "test-model",
    providerKey: "offline-stub",
  } as unknown as ChatResponse;
  return {
    key: "offline-stub",
    model: "test",
    offline: true,
    chat: vi.fn().mockResolvedValue(response),
    stream: vi.fn(),
    embed: vi.fn(),
    models: vi.fn(),
    ping: vi.fn(),
  } as unknown as AIProvider;
}

describe("extractJson", () => {
  it("parses raw JSON object", () => {
    expect(extractJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });
  it("parses raw JSON array", () => {
    expect(extractJson<number[]>("[1,2,3]")).toEqual([1, 2, 3]);
  });
  it("strips ```json fences", () => {
    expect(extractJson<{ a: number }>('```json\n{"a":2}\n```')).toEqual({ a: 2 });
  });
  it("strips plain ``` fences", () => {
    expect(extractJson<{ a: number }>('```\n{"a":3}\n```')).toEqual({ a: 3 });
  });
  it("extracts JSON object embedded in prose", () => {
    expect(extractJson<{ a: number }>('Here is the answer: {"a": 4} thanks!')).toEqual({ a: 4 });
  });
  it("extracts JSON array embedded in prose", () => {
    expect(extractJson<number[]>("preamble [1, 2] postamble")).toEqual([1, 2]);
  });
  it("throws when no JSON present", () => {
    expect(() => extractJson("no json here")).toThrow();
  });
  it("throws when JSON braces are unbalanced", () => {
    expect(() => extractJson("{ a:")).toThrow();
  });
});

describe("callJsonLlm", () => {
  it("appends the strict-JSON reminder and returns parsed payload", async () => {
    const provider = makeProvider('{"verdict":"ok"}');
    const out = await callJsonLlm<{ verdict: string }>(provider, {
      systemPrompt: "You are X.",
      userPrompt: "Do Y.",
    });
    expect(out.parsed).toEqual({ verdict: "ok" });
    const calls = (provider.chat as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBe(1);
    const messages = calls[0][0] as ChatMessage[];
    expect(messages[0]).toEqual({ role: "system", content: "You are X." });
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toContain("Do Y.");
    expect(messages[1].content).toContain("Respond with a single JSON object only");
  });

  it("forwards modelOverride + reasoningEffort + promptCaching", async () => {
    const provider = makeProvider("[]");
    await callJsonLlm(provider, {
      systemPrompt: "s",
      userPrompt: "u",
      modelOverride: "claude-sonnet",
      reasoningEffort: "high",
      promptCaching: true,
      maxTokens: 4096,
    });
    const opts = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(opts.model).toBe("claude-sonnet");
    expect(opts.reasoningEffort).toBe("high");
    expect(opts.maxTokens).toBe(4096);
    expect(opts.promptCaching).toEqual({ system: true, messages: true });
  });

  it("propagates JSON parse errors", async () => {
    const provider = makeProvider("not-json");
    await expect(callJsonLlm(provider, { systemPrompt: "s", userPrompt: "u" })).rejects.toThrow();
  });
});
