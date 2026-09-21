/** Epic #708 / Issue #710 — rule-compiler tests. */
import { describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatResponse } from "../ai/types.js";
import { compileRule, normaliseCompiledMeta } from "./rule-compiler.js";

function provider(content: string): AIProvider {
  const resp: ChatResponse = {
    role: "assistant",
    content,
    finishReason: "stop",
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    model: "test",
    providerKey: "offline-stub",
  } as unknown as ChatResponse;
  return {
    key: "offline-stub",
    model: "test",
    offline: true,
    chat: vi.fn().mockResolvedValue(resp),
    stream: vi.fn(),
    embed: vi.fn(),
    models: vi.fn(),
    ping: vi.fn(),
  } as unknown as AIProvider;
}

describe("normaliseCompiledMeta", () => {
  it("accepts a well-formed payload", () => {
    const meta = normaliseCompiledMeta({
      keywords: ["sql", "query", "concat"],
      symbolKinds: ["function", "method"],
      exemplars: ["fn builds SQL via string concatenation"],
    });
    expect(meta.keywords).toContain("sql");
    expect(meta.symbolKinds).toEqual(["function", "method"]);
    expect(meta.exemplars.length).toBe(1);
  });

  it("lowercases + dedupes keywords and clamps to 12", () => {
    const meta = normaliseCompiledMeta({
      keywords: Array.from({ length: 20 }, (_, i) => `KW${i}`).concat(["KW0", "KW0"]),
      symbolKinds: ["function"],
      exemplars: ["x"],
    });
    expect(meta.keywords.length).toBeLessThanOrEqual(12);
    expect(meta.keywords.every((k) => k === k.toLowerCase())).toBe(true);
  });

  it("filters unknown symbolKinds and defaults when empty", () => {
    const meta = normaliseCompiledMeta({
      keywords: ["k"],
      symbolKinds: ["nonsense", "Function"],
      exemplars: ["x"],
    });
    expect(meta.symbolKinds).toEqual(["function"]);

    const fallback = normaliseCompiledMeta({
      keywords: ["k"],
      symbolKinds: ["nonsense"],
      exemplars: ["x"],
    });
    expect(fallback.symbolKinds).toEqual(["function", "method"]);
  });

  it("rejects payload with no keywords", () => {
    expect(() =>
      normaliseCompiledMeta({ keywords: [], symbolKinds: ["function"], exemplars: ["x"] }),
    ).toThrow();
  });

  it("rejects payload with no exemplars", () => {
    expect(() =>
      normaliseCompiledMeta({ keywords: ["k"], symbolKinds: ["function"], exemplars: [] }),
    ).toThrow();
  });

  it("rejects non-object input", () => {
    expect(() => normaliseCompiledMeta(null)).toThrow();
    expect(() => normaliseCompiledMeta("bad")).toThrow();
  });

  it("clamps exemplars to 5 entries and 400 chars", () => {
    const meta = normaliseCompiledMeta({
      keywords: ["k"],
      symbolKinds: ["function"],
      exemplars: ["e1", "e2", "e3", "e4", "e5", "e6", "x".repeat(500)],
    });
    expect(meta.exemplars.length).toBe(5);
    expect(meta.exemplars.every((e) => e.length <= 400)).toBe(true);
  });
});

describe("compileRule", () => {
  it("calls the provider and returns compiled meta", async () => {
    const p = provider(
      JSON.stringify({
        keywords: ["sql", "string", "concat"],
        symbolKinds: ["function"],
        exemplars: ["fn concatenates strings into SQL"],
      }),
    );
    const out = await compileRule(p, {
      naturalLanguage: "Detect SQL injection from string concatenation",
      category: "security",
      severity: "high",
    });
    expect(out.meta.keywords).toContain("sql");
    expect(out.totalTokens).toBe(150);
    const calls = (p.chat as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0][1].content).toContain("METIS_REPO_CONTENT_BEGIN");
    expect(calls[0][0][1].content).toContain("Detect SQL injection");
  });

  it("propagates compile failures", async () => {
    const p = provider(JSON.stringify({ keywords: [], symbolKinds: [], exemplars: [] }));
    await expect(compileRule(p, { naturalLanguage: "x" })).rejects.toThrow();
  });
});
