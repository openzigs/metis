/**
 * Tests for the assumptions + risks elicitor (Epic #208 / Issue #232).
 *
 * Structured output via JSON-in-prompt + a `parseAssumptionRisk()` validator
 * (strip fences → JSON.parse → per-item Zod, applied AFTER parse, never at the
 * model boundary). The provider is mocked; no network.
 */
import { describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatMessage, ChatResponse } from "../src/lib/ai/types.js";
import {
  AssumptionRiskElicitor,
  parseAssumptionRisk,
} from "../src/lib/analysis/assumption-risk-elicitor.js";

function mockProvider(reply: string, capture?: (m: ChatMessage[]) => void): AIProvider {
  return {
    key: "offline-stub",
    model: "stub",
    offline: true,
    chat: vi.fn(async (messages: ChatMessage[]) => {
      capture?.(messages);
      return {
        content: reply,
        usage: { promptTokens: 4, completionTokens: 6, totalTokens: 10 },
        model: "stub",
        provider: "offline-stub",
      } satisfies ChatResponse;
    }),
    stream: vi.fn(),
    embed: vi.fn(),
    models: vi.fn(async () => ["stub"]),
    ping: vi.fn(async () => true),
  } as unknown as AIProvider;
}

describe("parseAssumptionRisk", () => {
  it("parses assumptions + risks and synthesises ids", () => {
    const json = JSON.stringify({
      assumptions: [
        {
          statement: "Users have stable internet.",
          rationale: "The app is online-only.",
          impactIfFalse: "high",
        },
      ],
      risks: [
        {
          title: "Third-party outage",
          description: "The payment provider may be unavailable.",
          likelihood: "medium",
          impact: "high",
          mitigation: "Queue and retry.",
        },
      ],
    });
    const result = parseAssumptionRisk(json);
    expect(result.assumptions).toHaveLength(1);
    expect(result.assumptions[0]!.impactIfFalse).toBe("high");
    expect(result.assumptions[0]!.id).toBeTruthy();
    expect(result.risks).toHaveLength(1);
    expect(result.risks[0]!.likelihood).toBe("medium");
    expect(result.risks[0]!.mitigation).toBe("Queue and retry.");
    expect(result.risks[0]!.id).toBeTruthy();
  });

  it("applies schema defaults for omitted optional fields", () => {
    const json = JSON.stringify({
      assumptions: [{ statement: "X is true." }],
      risks: [{ title: "R", description: "A risk." }],
    });
    const result = parseAssumptionRisk(json);
    expect(result.assumptions[0]!.rationale).toBe("");
    expect(result.assumptions[0]!.impactIfFalse).toBe("medium");
    expect(result.risks[0]!.likelihood).toBe("medium");
    expect(result.risks[0]!.impact).toBe("medium");
    expect(result.risks[0]!.mitigation).toBe("");
  });

  it("strips markdown fences", () => {
    const fenced =
      '```json\n{"assumptions":[{"statement":"s"}],"risks":[{"title":"t","description":"d"}]}\n```';
    const result = parseAssumptionRisk(fenced);
    expect(result.assumptions).toHaveLength(1);
    expect(result.risks).toHaveLength(1);
  });

  it("drops invalid items but keeps valid siblings", () => {
    const json = JSON.stringify({
      assumptions: [
        { statement: "valid" },
        { statement: "", rationale: "empty statement" },
        { rationale: "no statement at all" },
        42,
      ],
      risks: [
        { title: "ok", description: "ok" },
        { title: "bad-level", description: "x", likelihood: "catastrophic" },
        { title: "", description: "empty title" },
      ],
    });
    const result = parseAssumptionRisk(json);
    expect(result.assumptions).toHaveLength(1);
    expect(result.assumptions[0]!.statement).toBe("valid");
    expect(result.risks).toHaveLength(1);
    expect(result.risks[0]!.title).toBe("ok");
  });

  it("returns empty on non-JSON or wrong shape", () => {
    expect(parseAssumptionRisk("nope")).toEqual({ assumptions: [], risks: [] });
    expect(parseAssumptionRisk(JSON.stringify(["array"]))).toEqual({ assumptions: [], risks: [] });
    expect(parseAssumptionRisk(JSON.stringify({ other: 1 }))).toEqual({
      assumptions: [],
      risks: [],
    });
  });

  it("tolerates non-array assumptions/risks fields", () => {
    const result = parseAssumptionRisk(JSON.stringify({ assumptions: "x", risks: 9 }));
    expect(result).toEqual({ assumptions: [], risks: [] });
  });
});

describe("AssumptionRiskElicitor.elicit", () => {
  it("returns empty without calling the model on blank input", async () => {
    const provider = mockProvider("{}");
    const elicitor = new AssumptionRiskElicitor({ provider });
    const result = await elicitor.elicit("\n\t ");
    expect(provider.chat).not.toHaveBeenCalled();
    expect(result.assumptions).toEqual([]);
    expect(result.risks).toEqual([]);
    expect(result.usage.totalTokens).toBe(0);
  });

  it("elicits assumptions + risks and disables tools", async () => {
    let captured: ChatMessage[] = [];
    const reply = JSON.stringify({
      assumptions: [{ statement: "Single tenant per deployment." }],
      risks: [{ title: "Scope creep", description: "Requirements may expand." }],
    });
    const provider = mockProvider(reply, (m) => {
      captured = m;
    });
    const elicitor = new AssumptionRiskElicitor({ provider });
    const result = await elicitor.elicit("Deploy one instance per customer.");

    const opts = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(opts.disableTools).toBe(true);
    expect(captured.map((c) => c.content).join("\n")).toContain("per customer");
    expect(result.assumptions).toHaveLength(1);
    expect(result.risks[0]!.title).toBe("Scope creep");
    expect(result.usage.totalTokens).toBe(10);
  });

  it("passes the model override and abort signal through", async () => {
    const provider = mockProvider(JSON.stringify({ assumptions: [], risks: [] }));
    const elicitor = new AssumptionRiskElicitor({ provider, model: "custom" });
    const controller = new AbortController();
    await elicitor.elicit("input", controller.signal);
    expect(provider.chat).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ model: "custom", disableTools: true, signal: controller.signal }),
    );
  });
});
