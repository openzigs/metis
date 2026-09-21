/**
 * Tests for the cross-document detection pass (Issue #221 integration).
 *
 * `runCrossDocDetection` ties together the reusable consistency validator
 * (#218), NLI contradiction detection (#219), and the completeness checklist
 * (#220), normalising their output into the first-class `CrossDocFinding[]`
 * shape that is persisted (Prisma) and surfaced on the analysis snapshot.
 */
import { describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatMessage, ChatResponse } from "../src/lib/ai/types.js";
import { runCrossDocDetection } from "../src/lib/analysis/cross-doc-detection.js";
import type { DocSegment } from "../src/lib/analysis/cross-doc-validator.js";

/**
 * Routes replies by inspecting the system prompt so a single provider can serve
 * all three detector passes deterministically (mirrors the offline-stub seam).
 */
function routingProvider(opts: { nli?: string; completeness?: string }): AIProvider {
  return {
    key: "offline-stub",
    model: "stub",
    offline: true,
    chat: vi.fn(async (messages: ChatMessage[]) => {
      const system = messages.find((m) => m.role === "system")?.content ?? "";
      const sys = typeof system === "string" ? system : "";
      let content = "{}";
      if (sys.includes("Natural Language Inference")) content = opts.nli ?? '{"verdicts":[]}';
      else if (sys.includes("completeness")) content = opts.completeness ?? '{"gaps":[]}';
      return {
        content,
        usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 },
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

const SEGMENTS: DocSegment[] = [
  { id: "docA", label: "spec.md", content: "Payments settle within 24 hours." },
  { id: "docB", label: "plan.md", content: "Payments settle in 3 business days." },
];

describe("runCrossDocDetection", () => {
  it("normalises contradictions and completeness gaps into a unified findings list", async () => {
    const provider = routingProvider({
      nli: JSON.stringify({
        verdicts: [
          {
            premise: "settle within 24 hours",
            hypothesis: "settle in 3 business days",
            label: "contradiction",
            evidenceIds: ["docA", "docB"],
            scope: "pairwise",
          },
        ],
      }),
      completeness: JSON.stringify({
        gaps: [
          {
            kind: "missing-nfr",
            title: "No availability NFR",
            rationale: "No uptime target stated.",
            evidenceIds: ["docA"],
          },
        ],
      }),
    });

    const result = await runCrossDocDetection({ provider, segments: SEGMENTS });

    expect(result.contradictionCount).toBe(1);
    expect(result.completenessGapCount).toBe(1);
    expect(result.findings).toHaveLength(2);

    const contradiction = result.findings.find((f) => f.kind === "contradiction");
    expect(contradiction).toBeDefined();
    expect(contradiction!.scope).toBe("pairwise");
    expect(contradiction!.evidenceIds).toEqual(["docA", "docB"]);
    expect(contradiction!.severity).toBe("high");

    const gap = result.findings.find((f) => f.kind === "missing-nfr");
    expect(gap).toBeDefined();
    expect(gap!.scope).toBeNull();
    expect(gap!.detail).toContain("uptime");
    expect(typeof result.generatedAt).toBe("string");
    expect(result.usage.totalTokens).toBeGreaterThan(0);
  });

  it("returns an empty bundle for an empty corpus without calling the model", async () => {
    const provider = routingProvider({});
    const result = await runCrossDocDetection({ provider, segments: [] });
    expect(provider.chat).not.toHaveBeenCalled();
    expect(result.findings).toEqual([]);
    expect(result.contradictionCount).toBe(0);
    expect(result.completenessGapCount).toBe(0);
  });

  it("produces deterministic parseable findings from the offline-stub-shaped empty replies", async () => {
    // Both detectors return their valid empty shapes — the pass must not throw
    // and must yield an empty (but well-formed) bundle.
    const provider = routingProvider({ nli: '{"verdicts":[]}', completeness: '{"gaps":[]}' });
    const result = await runCrossDocDetection({ provider, segments: SEGMENTS });
    expect(result.findings).toEqual([]);
    expect(result.generatedAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("assigns deterministic ids and severities by kind", async () => {
    const provider = routingProvider({
      completeness: JSON.stringify({
        gaps: [
          { kind: "missing-risk", title: "No risks", rationale: "none documented" },
          { kind: "missing-assumption", title: "No assumptions", rationale: "none stated" },
        ],
      }),
    });
    const result = await runCrossDocDetection({ provider, segments: SEGMENTS });
    const ids = result.findings.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length); // unique
    const risk = result.findings.find((f) => f.kind === "missing-risk");
    const assumption = result.findings.find((f) => f.kind === "missing-assumption");
    expect(risk!.severity).toBe("medium");
    expect(assumption!.severity).toBe("low");
  });
});
