/**
 * Tests for NLI-style contradiction detection (Issue #219).
 *
 * The detector classifies statement pairs as entailment / neutral /
 * contradiction across the ingested-doc set, detecting both self-contradictions
 * (within one document) and pairwise contradictions (across documents). It uses
 * the JSON-in-prompt + `parseNliResponse()` validator pattern with Zod applied
 * AFTER parse — never at the model boundary.
 */
import { describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatMessage, ChatResponse } from "../src/lib/ai/types.js";
import {
  ContradictionDetector,
  parseNliResponse,
} from "../src/lib/analysis/contradiction-detector.js";
import type { DocSegment } from "../src/lib/analysis/cross-doc-validator.js";

function mockProvider(replies: string[], capture?: (m: ChatMessage[]) => void): AIProvider {
  let call = 0;
  return {
    key: "offline-stub",
    model: "stub",
    offline: true,
    chat: vi.fn(async (messages: ChatMessage[]) => {
      capture?.(messages);
      const content = replies[Math.min(call, replies.length - 1)] ?? "{}";
      call += 1;
      return {
        content,
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

const SEG_A: DocSegment = {
  id: "docA",
  label: "spec.md",
  content: "Payments must settle within 24 hours. The system must settle payments instantly.",
};
const SEG_B: DocSegment = {
  id: "docB",
  label: "plan.md",
  content: "Payments settle in 3 business days.",
};

describe("parseNliResponse", () => {
  it("parses verdicts and keeps only valid labels (Zod post-parse)", () => {
    const json = JSON.stringify({
      verdicts: [
        { premise: "p1", hypothesis: "h1", label: "contradiction", evidenceIds: ["docA"] },
        { premise: "p2", hypothesis: "h2", label: "entailment", evidenceIds: [] },
      ],
    });
    const parsed = parseNliResponse(json);
    expect(parsed.verdicts).toHaveLength(2);
    expect(parsed.verdicts[0]!.label).toBe("contradiction");
    expect(parsed.verdicts[0]!.evidenceIds).toEqual(["docA"]);
  });

  it("strips markdown fences before parsing", () => {
    const fenced =
      '```json\n{"verdicts":[{"premise":"a","hypothesis":"b","label":"neutral"}]}\n```';
    const parsed = parseNliResponse(fenced);
    expect(parsed.verdicts).toHaveLength(1);
    expect(parsed.verdicts[0]!.evidenceIds).toEqual([]);
  });

  it("drops verdicts that fail Zod validation but keeps valid siblings", () => {
    const json = JSON.stringify({
      verdicts: [
        { premise: "ok", hypothesis: "ok", label: "contradiction" },
        { premise: "", hypothesis: "bad", label: "contradiction" }, // empty premise → invalid
        { premise: "x", hypothesis: "y", label: "not-a-label" }, // bad enum → invalid
      ],
    });
    const parsed = parseNliResponse(json);
    expect(parsed.verdicts).toHaveLength(1);
    expect(parsed.verdicts[0]!.premise).toBe("ok");
  });

  it("returns an empty result for non-JSON", () => {
    expect(parseNliResponse("totally not json").verdicts).toEqual([]);
  });

  it("returns an empty result when 'verdicts' is missing", () => {
    expect(parseNliResponse(JSON.stringify({ foo: 1 })).verdicts).toEqual([]);
  });
});

describe("ContradictionDetector.detect", () => {
  it("detects a self-contradiction within a single document", async () => {
    const reply = JSON.stringify({
      verdicts: [
        {
          premise: "Payments must settle within 24 hours.",
          hypothesis: "The system must settle payments instantly.",
          label: "contradiction",
          evidenceIds: ["docA"],
          scope: "self",
        },
      ],
    });
    const provider = mockProvider([reply]);
    const detector = new ContradictionDetector({ provider });
    const result = await detector.detect([SEG_A]);

    expect(result.contradictions).toHaveLength(1);
    expect(result.contradictions[0]!.scope).toBe("self");
    expect(result.contradictions[0]!.evidenceIds).toEqual(["docA"]);
    expect(result.usage.totalTokens).toBeGreaterThan(0);
  });

  it("detects a pairwise contradiction across two documents", async () => {
    // First call = self-pass per doc (no contradictions), second = pairwise.
    const selfNone = JSON.stringify({ verdicts: [] });
    const pairwise = JSON.stringify({
      verdicts: [
        {
          premise: "Payments settle within 24 hours.",
          hypothesis: "Payments settle in 3 business days.",
          label: "contradiction",
          evidenceIds: ["docA", "docB"],
          scope: "pairwise",
        },
        {
          premise: "unrelated",
          hypothesis: "unrelated",
          label: "neutral",
          evidenceIds: ["docA", "docB"],
        },
      ],
    });
    const provider = mockProvider([selfNone, selfNone, pairwise]);
    const detector = new ContradictionDetector({ provider });
    const result = await detector.detect([SEG_A, SEG_B]);

    // Only the contradiction is surfaced; the neutral pair is discarded.
    expect(result.contradictions).toHaveLength(1);
    expect(result.contradictions[0]!.scope).toBe("pairwise");
    expect(result.contradictions[0]!.evidenceIds).toEqual(["docA", "docB"]);
  });

  it("returns no contradictions when the corpus is empty", async () => {
    const provider = mockProvider(["{}"]);
    const detector = new ContradictionDetector({ provider });
    const result = await detector.detect([]);
    expect(provider.chat).not.toHaveBeenCalled();
    expect(result.contradictions).toEqual([]);
    expect(result.usage.totalTokens).toBe(0);
  });

  it("filters out entailment/neutral labels, surfacing only contradictions", async () => {
    const reply = JSON.stringify({
      verdicts: [
        { premise: "a", hypothesis: "b", label: "entailment", evidenceIds: ["docA"] },
        { premise: "c", hypothesis: "d", label: "neutral", evidenceIds: ["docA"] },
      ],
    });
    const provider = mockProvider([reply]);
    const detector = new ContradictionDetector({ provider });
    const result = await detector.detect([SEG_A]);
    expect(result.contradictions).toEqual([]);
  });

  it("caps pairwise comparisons to bound LLM calls on large corpora", async () => {
    const segs: DocSegment[] = Array.from({ length: 6 }, (_, i) => ({
      id: `doc${i}`,
      label: `d${i}.md`,
      content: `content ${i}`,
    }));
    const provider = mockProvider(["{}"]);
    const detector = new ContradictionDetector({ provider, maxPairwiseComparisons: 3 });
    await detector.detect(segs);
    // 6 self-passes + at most 3 pairwise = 9 calls (not the full 15 pairs).
    expect((provider.chat as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(9);
  });

  it("honours an already-aborted signal", async () => {
    const provider = mockProvider(["{}"]);
    const detector = new ContradictionDetector({ provider });
    const controller = new AbortController();
    controller.abort();
    await expect(detector.detect([SEG_A], { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});
