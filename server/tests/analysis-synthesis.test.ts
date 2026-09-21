/**
 * Tests for the synthesis agent: priority inference, deterministic fallback,
 * cosine-style title dedup, and graceful schema-error handling.
 */
import { describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatMessage, ChatResponse } from "../src/lib/ai/types.js";
import {
  fallbackSynthesize,
  inferPriority,
  runSynthesis,
  titleSimilarity,
  type FlatFinding,
} from "../src/lib/analysis/synthesis.js";

const fmt = (overrides: Partial<FlatFinding> = {}): FlatFinding => ({
  agentKey: "document",
  category: "other",
  severity: "info",
  title: "untitled",
  body: "...",
  tags: [],
  citations: [],
  ...overrides,
});

const stubResponse = (content: string): ChatResponse => ({
  content,
  usage: { promptTokens: 5, completionTokens: 7, totalTokens: 12 },
  model: "stub",
  provider: "offline-stub",
});

const makeProvider = (handler: (m: ChatMessage[]) => Promise<ChatResponse>): AIProvider =>
  ({
    key: "offline-stub",
    model: "stub",
    offline: true,
    chat: vi.fn(handler),
    stream: vi.fn(),
    embed: vi.fn(),
    models: vi.fn(async () => ["stub"]),
    ping: vi.fn(async () => true),
  }) as unknown as AIProvider;

describe("titleSimilarity", () => {
  it("returns 1 for identical titles", () => {
    expect(titleSimilarity("Audit log retention", "Audit log retention")).toBe(1);
  });
  it("scores related titles above the dedup threshold", () => {
    expect(titleSimilarity("Audit log retention", "audit retention policy")).toBeGreaterThan(0.3);
  });
  it("returns 0 for unrelated titles", () => {
    expect(titleSimilarity("Audit", "Performance")).toBe(0);
  });
});

describe("inferPriority", () => {
  it("returns critical when any finding is compliance/critical", () => {
    expect(inferPriority([fmt({ category: "compliance", severity: "low" })])).toBe("critical");
    expect(inferPriority([fmt({ severity: "critical" })])).toBe("critical");
  });
  it("returns high for security/high severity", () => {
    expect(inferPriority([fmt({ category: "security" })])).toBe("high");
    expect(inferPriority([fmt({ severity: "high" })])).toBe("high");
  });
  it("returns medium and low for the relevant severities", () => {
    expect(inferPriority([fmt({ severity: "medium" })])).toBe("medium");
    expect(inferPriority([fmt({ severity: "info" })])).toBe("low");
  });
});

describe("fallbackSynthesize", () => {
  it("clusters near-duplicate findings into one requirement", () => {
    const out = fallbackSynthesize([
      fmt({ title: "Audit log retention" }),
      fmt({ title: "audit retention policy" }),
      fmt({ title: "Add CDN caching" }),
    ]);
    expect(out.requirements).toHaveLength(2);
    const audit = out.requirements.find((r) => r.title.toLowerCase().startsWith("audit"));
    expect(audit?.evidenceFindingIndexes).toHaveLength(2);
  });

  it("flags compliance findings as critical priority", () => {
    const out = fallbackSynthesize([fmt({ category: "compliance", title: "NERC CIP" })]);
    expect(out.requirements[0].priority).toBe("critical");
  });
});

describe("runSynthesis", () => {
  const findings = [
    fmt({ title: "Add OAuth2 login", category: "security", severity: "high" }),
    fmt({ title: "Add SSO via OAuth", category: "security", severity: "medium" }),
  ];

  it("validates and persists structured LLM output", async () => {
    const llm = JSON.stringify({
      summary: "two security items",
      requirements: [
        {
          type: "feature",
          title: "Implement OAuth2",
          body: "Adopt OAuth2 across the app.",
          priority: "high",
          labels: ["security", "auth"],
          evidenceFindingIndexes: [0, 1],
        },
      ],
    });
    const provider = makeProvider(async () => stubResponse(llm));
    const result = await runSynthesis(provider, {
      projectName: "Acme",
      findings,
    });
    expect(result.output.requirements).toHaveLength(1);
    expect(result.output.requirements[0].evidenceFindingIndexes).toEqual([0, 1]);
    expect(result.usage.totalTokens).toBe(12);
  });

  it("falls back when the model emits non-JSON", async () => {
    const provider = makeProvider(async () => stubResponse("not json at all"));
    const result = await runSynthesis(provider, { projectName: "Acme", findings });
    expect(result.output.requirements.length).toBeGreaterThan(0);
  });

  it("falls back when the chat call throws", async () => {
    const provider = makeProvider(async () => {
      throw new Error("upstream offline");
    });
    const result = await runSynthesis(provider, { projectName: "Acme", findings });
    expect(result.output.requirements.length).toBeGreaterThan(0);
  });

  it("returns empty when there are no findings (skips the LLM round-trip)", async () => {
    const provider = makeProvider(async () => stubResponse("{}"));
    const result = await runSynthesis(provider, { projectName: "Acme", findings: [] });
    expect(result.output.requirements).toEqual([]);
    expect(provider.chat).not.toHaveBeenCalled();
  });

  it("clamps invalid evidence indexes from the model", async () => {
    const llm = JSON.stringify({
      summary: "x",
      requirements: [
        {
          type: "feature",
          title: "OAuth2",
          body: "x",
          priority: "high",
          labels: [],
          evidenceFindingIndexes: [0, 99, 1],
        },
      ],
    });
    const provider = makeProvider(async () => stubResponse(llm));
    const result = await runSynthesis(provider, { projectName: "Acme", findings });
    expect(result.output.requirements[0].evidenceFindingIndexes).toEqual([0, 1]);
  });

  it("aborts via signal", async () => {
    const provider = makeProvider(async () => stubResponse("{}"));
    const ac = new AbortController();
    ac.abort();
    await expect(
      runSynthesis(provider, { projectName: "x", findings, signal: ac.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  // Epic #201 (#212) — clarification-refined requirements must reach synthesis.
  it("passes refined requirements into the synthesis prompt", async () => {
    const seen: ChatMessage[][] = [];
    const provider = makeProvider(async (msgs) => {
      seen.push(msgs);
      return stubResponse(JSON.stringify({ summary: "x", requirements: [] }));
    });
    await runSynthesis(provider, {
      projectName: "Acme",
      findings,
      refinedRequirements: [{ title: "Audit logging", description: "Retain logs for 30 days" }],
    });
    const userContent = seen[0]!.map((m) => m.content).join("\n");
    expect(userContent).toContain("CLARIFIED REQUIREMENTS");
    expect(userContent).toContain("Retain logs for 30 days");
  });

  it("changing a refined answer changes the synthesized requirement output", async () => {
    // The model echoes the clarified description back as a requirement body, so
    // a different answer yields a different generated spec section.
    const provider = makeProvider(async (msgs) => {
      const text = msgs.map((m) => m.content).join("\n");
      const retention = text.includes("7 years") ? "7 years" : "30 days";
      return stubResponse(
        JSON.stringify({
          summary: "s",
          requirements: [
            {
              type: "feature",
              title: "Audit logging",
              body: `Retain logs for ${retention}`,
              priority: "high",
              labels: [],
              evidenceFindingIndexes: [0],
            },
          ],
        }),
      );
    });
    const run = (answer: string) =>
      runSynthesis(provider, {
        projectName: "Acme",
        findings,
        refinedRequirements: [{ title: "Audit logging", description: `Retain logs for ${answer}` }],
      });
    const a = await run("30 days");
    const b = await run("7 years");
    expect(a.output.requirements[0]!.body).toContain("30 days");
    expect(b.output.requirements[0]!.body).toContain("7 years");
    expect(a.output.requirements[0]!.body).not.toEqual(b.output.requirements[0]!.body);
  });
});
