/**
 * Tests for the reusable cross-document consistency validator (Issue #218).
 *
 * The validator generalizes the spec-kit `/analyze` consistency logic so it
 * runs over an arbitrary set of document segments (e.g. ingested customer
 * docs) instead of only the spec/plan/tasks artifacts. It asks the LLM (via
 * the shared `AIProvider.chat` surface, `disableTools: true`) to emit the
 * Markdown consistency report and parses it into a structured shape.
 */
import { describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatMessage, ChatResponse } from "../src/lib/ai/types.js";
import {
  CrossDocValidator,
  parseConsistencyReport,
  type DocSegment,
} from "../src/lib/analysis/cross-doc-validator.js";

function mockProvider(reply: string, capture?: (m: ChatMessage[]) => void): AIProvider {
  return {
    key: "offline-stub",
    model: "stub",
    offline: true,
    chat: vi.fn(async (messages: ChatMessage[]) => {
      capture?.(messages);
      return {
        content: reply,
        usage: { promptTokens: 5, completionTokens: 7, totalTokens: 12 },
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
  { id: "docA", label: "spec.md", content: "The API must respond within 200ms." },
  { id: "docB", label: "plan.md", content: "The API may take up to 5 seconds." },
];

describe("parseConsistencyReport", () => {
  it("parses verdict and section bullets from a well-formed report", () => {
    const report = [
      "## Summary",
      "",
      "WARN",
      "",
      "## Uncovered acceptance criteria",
      "- AC-3 has no matching component",
      "",
      "## Orphan components",
      "- none",
      "",
      "## Contradictions",
      "- docA requires 200ms but docB allows 5s",
      "",
      "## Next actions",
      "- reconcile latency targets",
    ].join("\n");
    const parsed = parseConsistencyReport(report);
    expect(parsed.verdict).toBe("WARN");
    expect(parsed.uncoveredAcceptanceCriteria).toEqual(["AC-3 has no matching component"]);
    expect(parsed.orphanComponents).toEqual([]);
    expect(parsed.contradictions).toEqual(["docA requires 200ms but docB allows 5s"]);
    expect(parsed.nextActions).toEqual(["reconcile latency targets"]);
  });

  it("treats `- none` as an empty section", () => {
    const parsed = parseConsistencyReport("## Summary\nOK\n\n## Contradictions\n- none");
    expect(parsed.contradictions).toEqual([]);
  });

  it("returns UNKNOWN when no Summary header is present", () => {
    const parsed = parseConsistencyReport("garbage with no headers");
    expect(parsed.verdict).toBe("UNKNOWN");
    expect(parsed.contradictions).toEqual([]);
  });

  it("normalizes verdict casing and rejects unknown verdicts", () => {
    expect(parseConsistencyReport("## Summary\nblock").verdict).toBe("BLOCK");
    expect(parseConsistencyReport("## Summary\nMAYBE").verdict).toBe("UNKNOWN");
  });
});

describe("CrossDocValidator.validate", () => {
  it("calls the provider with disableTools and includes every segment in the prompt", async () => {
    let captured: ChatMessage[] = [];
    const provider = mockProvider("## Summary\nOK\n\n## Contradictions\n- none", (m) => {
      captured = m;
    });
    const v = new CrossDocValidator({ provider });
    const result = await v.validate(SEGMENTS);

    expect(provider.chat).toHaveBeenCalledTimes(1);
    const opts = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(opts.disableTools).toBe(true);
    const userText = captured.map((c) => c.content).join("\n");
    expect(userText).toContain("spec.md");
    expect(userText).toContain("plan.md");
    expect(userText).toContain("200ms");
    expect(result.report.verdict).toBe("OK");
    expect(result.usage.totalTokens).toBe(12);
  });

  it("returns the structured contradictions for a contradictory corpus", async () => {
    const provider = mockProvider(
      "## Summary\nBLOCK\n\n## Contradictions\n- docA contradicts docB on latency",
    );
    const v = new CrossDocValidator({ provider });
    const result = await v.validate(SEGMENTS);
    expect(result.report.verdict).toBe("BLOCK");
    expect(result.report.contradictions).toEqual(["docA contradicts docB on latency"]);
  });

  it("short-circuits to an empty OK report when fewer than 1 segment is supplied", async () => {
    const provider = mockProvider("unused");
    const v = new CrossDocValidator({ provider });
    const result = await v.validate([]);
    expect(provider.chat).not.toHaveBeenCalled();
    expect(result.report.verdict).toBe("OK");
    expect(result.report.contradictions).toEqual([]);
    expect(result.usage.totalTokens).toBe(0);
  });

  it("honours an already-aborted signal", async () => {
    const provider = mockProvider("## Summary\nOK");
    const v = new CrossDocValidator({ provider });
    const controller = new AbortController();
    controller.abort();
    await expect(v.validate(SEGMENTS, { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});
