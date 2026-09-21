/** Epic #708 / Issue #712 — per-symbol-scanner tests. */
import { describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatResponse } from "../ai/types.js";
import { parseCandidates, scanSymbol } from "./per-symbol-scanner.js";

const symbol = {
  symbolId: "s1",
  qualifiedName: "src/foo.ts::bar",
  filePath: "src/foo.ts",
  language: "ts",
  startLine: 10,
  endLine: 20,
  body: "function bar(){\n  return doIt();\n}",
};

function provider(content: string): AIProvider {
  const r: ChatResponse = {
    role: "assistant",
    content,
    finishReason: "stop",
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    model: "m",
    providerKey: "offline-stub",
  } as unknown as ChatResponse;
  return {
    key: "offline-stub",
    model: "m",
    offline: true,
    chat: vi.fn().mockResolvedValue(r),
    stream: vi.fn(),
    embed: vi.fn(),
    models: vi.fn(),
    ping: vi.fn(),
  } as unknown as AIProvider;
}

describe("parseCandidates", () => {
  it("returns [] when findings absent or non-array", () => {
    expect(parseCandidates(undefined, symbol)).toEqual([]);
    expect(
      parseCandidates({ findings: "no" } as unknown as { findings?: unknown }, symbol),
    ).toEqual([]);
    expect(parseCandidates({ findings: [] }, symbol)).toEqual([]);
  });

  it("drops findings missing title or body", () => {
    const out = parseCandidates(
      {
        findings: [
          { title: "", body: "x", severity: "low", evidence_lines: [10] },
          { title: "ok", body: "", severity: "low", evidence_lines: [10] },
        ],
      },
      symbol,
    );
    expect(out).toEqual([]);
  });

  it("drops findings whose evidence lines all fall outside the symbol", () => {
    const out = parseCandidates(
      {
        findings: [
          { ruleId: "r", title: "t", body: "b", severity: "high", evidence_lines: [1, 2, 99] },
        ],
      },
      symbol,
    );
    expect(out).toEqual([]);
  });

  it("normalises severity, clamps confidence, defaults category", () => {
    const [c] = parseCandidates(
      {
        findings: [
          {
            ruleId: null,
            title: "bad sql",
            body: "uses raw query",
            severity: "HIGH",
            evidence_lines: [12, 13],
            confidence: 1.7,
          },
        ],
      },
      symbol,
    );
    expect(c.severity).toBe("high");
    expect(c.confidence).toBe(1);
    expect(c.category).toBe("correctness");
    expect(c.evidenceLines).toEqual([12, 13]);
    expect(c.ruleId).toBeNull();
    expect(c.qualifiedName).toBe(symbol.qualifiedName);
  });

  it("defaults severity to medium when invalid", () => {
    const [c] = parseCandidates(
      {
        findings: [{ title: "t", body: "b", severity: "nuclear", evidence_lines: [11] }],
      },
      symbol,
    );
    expect(c.severity).toBe("medium");
  });

  it("defaults confidence to 0.5 when missing or non-finite", () => {
    const out = parseCandidates(
      {
        findings: [
          { title: "a", body: "b", evidence_lines: [10] },
          { title: "c", body: "d", confidence: NaN, evidence_lines: [10] },
        ],
      },
      symbol,
    );
    expect(out[0].confidence).toBe(0.5);
    expect(out[1].confidence).toBe(0.5);
  });
});

describe("scanSymbol", () => {
  it("invokes the provider and parses candidates", async () => {
    const p = provider(
      JSON.stringify({
        findings: [
          {
            ruleId: "r1",
            title: "bug",
            body: "details",
            severity: "medium",
            category: "security",
            evidence_lines: [11],
            confidence: 0.8,
          },
        ],
      }),
    );
    const out = await scanSymbol(p, { symbol, ruleInstructions: "rules" });
    expect(out.candidates.length).toBe(1);
    expect(out.candidates[0].symbolId).toBe("s1");
    expect(out.totalTokens).toBe(150);
  });

  it("returns empty candidates on empty findings array", async () => {
    const p = provider(JSON.stringify({ findings: [] }));
    const out = await scanSymbol(p, { symbol, ruleInstructions: "rules" });
    expect(out.candidates).toEqual([]);
  });
});
