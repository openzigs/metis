/**
 * Tests for the completeness checklist (Issue #220).
 *
 * Detects missing NFRs, acceptance criteria, assumptions, and risks over the
 * ingested corpus. Structured output via JSON-in-prompt + `parseCompleteness()`
 * validator (strip fences → JSON.parse → Zod post-parse, never at the model
 * boundary).
 */
import { describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatMessage, ChatResponse } from "../src/lib/ai/types.js";
import {
  CompletenessChecker,
  parseCompleteness,
} from "../src/lib/analysis/completeness-checker.js";
import type { DocSegment } from "../src/lib/analysis/cross-doc-validator.js";

function mockProvider(reply: string, capture?: (m: ChatMessage[]) => void): AIProvider {
  return {
    key: "offline-stub",
    model: "stub",
    offline: true,
    chat: vi.fn(async (messages: ChatMessage[]) => {
      capture?.(messages);
      return {
        content: reply,
        usage: { promptTokens: 8, completionTokens: 9, totalTokens: 17 },
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
  { id: "docA", label: "spec.md", content: "Users can log in and view a dashboard." },
];

describe("parseCompleteness", () => {
  it("parses gaps and validates kind enum (Zod post-parse)", () => {
    const json = JSON.stringify({
      gaps: [
        {
          kind: "missing-nfr",
          title: "No performance NFR",
          rationale: "No latency or throughput targets are stated.",
          evidenceIds: ["docA"],
        },
        {
          kind: "missing-risk",
          title: "No risks documented",
          rationale: "No risk section present.",
          evidenceIds: [],
        },
      ],
    });
    const parsed = parseCompleteness(json);
    expect(parsed.gaps).toHaveLength(2);
    expect(parsed.gaps[0]!.kind).toBe("missing-nfr");
    expect(parsed.gaps[1]!.evidenceIds).toEqual([]);
  });

  it("strips markdown fences", () => {
    const fenced =
      '```json\n{"gaps":[{"kind":"missing-assumption","title":"t","rationale":"r"}]}\n```';
    const parsed = parseCompleteness(fenced);
    expect(parsed.gaps).toHaveLength(1);
    expect(parsed.gaps[0]!.kind).toBe("missing-assumption");
  });

  it("drops gaps with an invalid kind but keeps valid siblings", () => {
    const json = JSON.stringify({
      gaps: [
        { kind: "missing-nfr", title: "ok", rationale: "ok" },
        { kind: "missing-contradiction", title: "bad", rationale: "bad enum" },
        { kind: "missing-nfr", title: "", rationale: "empty title" },
      ],
    });
    const parsed = parseCompleteness(json);
    expect(parsed.gaps).toHaveLength(1);
    expect(parsed.gaps[0]!.title).toBe("ok");
  });

  it("returns empty on non-JSON or missing 'gaps'", () => {
    expect(parseCompleteness("nope").gaps).toEqual([]);
    expect(parseCompleteness(JSON.stringify({ x: 1 })).gaps).toEqual([]);
  });
});

describe("CompletenessChecker.check", () => {
  it("flags missing categories with rationale and disables tools", async () => {
    let captured: ChatMessage[] = [];
    const reply = JSON.stringify({
      gaps: [
        {
          kind: "missing-acceptance-criteria",
          title: "Login lacks acceptance criteria",
          rationale: "No measurable acceptance criteria for login.",
          evidenceIds: ["docA"],
        },
      ],
    });
    const provider = mockProvider(reply, (m) => {
      captured = m;
    });
    const checker = new CompletenessChecker({ provider });
    const result = await checker.check(SEGMENTS);

    const opts = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(opts.disableTools).toBe(true);
    expect(captured.map((c) => c.content).join("\n")).toContain("dashboard");
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]!.kind).toBe("missing-acceptance-criteria");
    expect(result.gaps[0]!.rationale).toContain("acceptance criteria");
    expect(result.usage.totalTokens).toBe(17);
  });

  it("returns no gaps for an empty corpus without calling the model", async () => {
    const provider = mockProvider("{}");
    const checker = new CompletenessChecker({ provider });
    const result = await checker.check([]);
    expect(provider.chat).not.toHaveBeenCalled();
    expect(result.gaps).toEqual([]);
    expect(result.usage.totalTokens).toBe(0);
  });

  it("accepts elicited artifacts as additional context (#208 interop)", async () => {
    let captured: ChatMessage[] = [];
    const provider = mockProvider(JSON.stringify({ gaps: [] }), (m) => {
      captured = m;
    });
    const checker = new CompletenessChecker({ provider });
    await checker.check(SEGMENTS, { elicitedArtifacts: "Assumption: users have accounts." });
    expect(captured.map((c) => c.content).join("\n")).toContain("users have accounts");
  });

  it("honours an already-aborted signal", async () => {
    const provider = mockProvider("{}");
    const checker = new CompletenessChecker({ provider });
    const controller = new AbortController();
    controller.abort();
    await expect(checker.check(SEGMENTS, { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});
