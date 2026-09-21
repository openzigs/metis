/**
 * Tests for the elicitation pipeline (Epic #208 / Issue #233).
 *
 * Ties the NFR/AC + assumptions/risks elicitors together and formats their
 * output into the `elicitedArtifacts` string consumed by the completeness
 * checklist (#203). Provider is mocked; the pipeline runs two provider calls.
 */
import { describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatMessage, ChatResponse } from "../src/lib/ai/types.js";
import type { DocSegment } from "../src/lib/analysis/cross-doc-validator.js";
import {
  formatElicitedArtifacts,
  isEmptyElicitation,
  joinCorpus,
  runElicitation,
} from "../src/lib/analysis/elicitation-pipeline.js";

/**
 * Provider that returns a queue of replies in order — the pipeline calls the
 * NFR elicitor first, then the assumptions/risks elicitor.
 */
function queuedProvider(replies: string[]): AIProvider {
  let i = 0;
  return {
    key: "offline-stub",
    model: "stub",
    offline: true,
    chat: vi.fn(async (_m: ChatMessage[]) => {
      const content = replies[Math.min(i, replies.length - 1)] ?? "{}";
      i += 1;
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
  { id: "docA", label: "spec.md", content: "Users log in and view a dashboard." },
  { id: "docB", label: "blank.md", content: "   " },
];

describe("joinCorpus", () => {
  it("joins usable segments and drops blanks", () => {
    const corpus = joinCorpus(SEGMENTS, 4000);
    expect(corpus).toContain("docA");
    expect(corpus).toContain("dashboard");
    expect(corpus).not.toContain("blank.md");
  });

  it("truncates segments past the cap", () => {
    const long: DocSegment[] = [{ id: "x", label: "l", content: "a".repeat(50) }];
    const corpus = joinCorpus(long, 10);
    expect(corpus).toContain("…[truncated]");
  });
});

describe("formatElicitedArtifacts", () => {
  it("renders every section with its metadata", () => {
    const text = formatElicitedArtifacts({
      nfrs: [
        {
          id: "1",
          category: "performance",
          title: "Fast",
          description: "be fast",
          metric: "p95<200ms",
          priority: "must-have",
        },
      ],
      acceptanceCriteria: [
        {
          id: "2",
          statement: "login works",
          given: "a user",
          when: "valid creds",
          then: "authenticated",
        },
      ],
      assumptions: [
        { id: "3", statement: "users have accounts", rationale: "", impactIfFalse: "high" },
      ],
      risks: [
        {
          id: "4",
          title: "outage",
          description: "provider down",
          likelihood: "low",
          impact: "high",
          mitigation: "",
        },
      ],
    });
    expect(text).toContain("Non-functional requirements:");
    expect(text).toContain("[p95<200ms]");
    expect(text).toContain("Acceptance criteria:");
    expect(text).toContain("Given a user");
    expect(text).toContain("Assumptions:");
    expect(text).toContain("impact-if-false: high");
    expect(text).toContain("Risks:");
    expect(text).toContain("likelihood: low");
  });

  it("omits empty sections and an empty NFR metric", () => {
    const text = formatElicitedArtifacts({
      nfrs: [
        {
          id: "1",
          category: "other",
          title: "t",
          description: "d",
          metric: "",
          priority: "should-have",
        },
      ],
      acceptanceCriteria: [],
      assumptions: [],
      risks: [],
    });
    expect(text).toContain("Non-functional requirements:");
    expect(text).not.toContain("Acceptance criteria:");
    expect(text).not.toContain("[]");
    expect(text).not.toMatch(/\[\s*\]/);
  });

  it("returns an empty string when there is nothing", () => {
    expect(
      formatElicitedArtifacts({ nfrs: [], acceptanceCriteria: [], assumptions: [], risks: [] }),
    ).toBe("");
  });
});

describe("isEmptyElicitation", () => {
  it("is true only when all four lists are empty", () => {
    expect(
      isEmptyElicitation({ nfrs: [], acceptanceCriteria: [], assumptions: [], risks: [] }),
    ).toBe(true);
    expect(
      isEmptyElicitation({
        nfrs: [],
        acceptanceCriteria: [],
        assumptions: [{ id: "a", statement: "s", rationale: "", impactIfFalse: "low" }],
        risks: [],
      }),
    ).toBe(false);
  });
});

describe("runElicitation", () => {
  it("returns empty without calling the model on a blank corpus", async () => {
    const provider = queuedProvider(["{}"]);
    const result = await runElicitation({
      provider,
      segments: [{ id: "x", label: "l", content: "  " }],
    });
    expect(provider.chat).not.toHaveBeenCalled();
    expect(isEmptyElicitation(result)).toBe(true);
    expect(result.usage.totalTokens).toBe(0);
  });

  it("runs both elicitors and accumulates usage", async () => {
    const provider = queuedProvider([
      JSON.stringify({
        nfrs: [{ category: "security", title: "Auth", description: "must authenticate" }],
        acceptanceCriteria: [{ statement: "login works" }],
      }),
      JSON.stringify({
        assumptions: [{ statement: "users have accounts" }],
        risks: [{ title: "outage", description: "provider down" }],
      }),
    ]);
    const result = await runElicitation({ provider, segments: SEGMENTS });
    expect(provider.chat).toHaveBeenCalledTimes(2);
    expect(result.nfrs).toHaveLength(1);
    expect(result.acceptanceCriteria).toHaveLength(1);
    expect(result.assumptions).toHaveLength(1);
    expect(result.risks).toHaveLength(1);
    // Two calls × 7 tokens each.
    expect(result.usage.totalTokens).toBe(14);
  });

  it("passes the model + signal through to the elicitors", async () => {
    const provider = queuedProvider([
      JSON.stringify({ nfrs: [], acceptanceCriteria: [] }),
      JSON.stringify({ assumptions: [], risks: [] }),
    ]);
    const controller = new AbortController();
    await runElicitation({
      provider,
      segments: SEGMENTS,
      model: "custom",
      signal: controller.signal,
    });
    const firstOpts = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(firstOpts.model).toBe("custom");
    expect(firstOpts.disableTools).toBe(true);
    expect(firstOpts.signal).toBe(controller.signal);
  });
});
