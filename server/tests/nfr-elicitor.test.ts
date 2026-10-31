/**
 * Tests for the NFR + acceptance-criteria elicitor (Epic #208 / Issue #231).
 *
 * Structured output via JSON-in-prompt + a `parseNfrAcceptance()` validator
 * (strip fences → JSON.parse → per-item Zod, applied AFTER parse, never at the
 * model boundary). The provider is mocked; no network.
 */
import { describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatMessage, ChatResponse } from "../src/lib/ai/types.js";
import { NfrElicitor, parseNfrAcceptance } from "../src/lib/analysis/nfr-elicitor.js";

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

describe("parseNfrAcceptance", () => {
  it("parses NFRs + acceptance criteria and synthesises ids", () => {
    const json = JSON.stringify({
      nfrs: [
        {
          category: "performance",
          title: "Fast search",
          description: "Search must be fast.",
          metric: "p95 < 200ms",
          priority: "must-have",
        },
      ],
      acceptanceCriteria: [
        {
          statement: "A user can log in with valid credentials.",
          given: "a registered user",
          when: "they submit valid credentials",
          then: "they are authenticated",
        },
      ],
    });
    const result = parseNfrAcceptance(json)!;
    expect(result.nfrs).toHaveLength(1);
    expect(result.nfrs[0]!.category).toBe("performance");
    expect(result.nfrs[0]!.metric).toBe("p95 < 200ms");
    expect(result.nfrs[0]!.id).toBeTruthy();
    expect(result.acceptanceCriteria).toHaveLength(1);
    expect(result.acceptanceCriteria[0]!.then).toBe("they are authenticated");
    expect(result.acceptanceCriteria[0]!.id).toBeTruthy();
  });

  it("applies schema defaults for omitted optional fields", () => {
    const json = JSON.stringify({
      nfrs: [{ category: "security", title: "Auth", description: "Must authenticate." }],
      acceptanceCriteria: [{ statement: "It works." }],
    });
    const result = parseNfrAcceptance(json)!;
    expect(result.nfrs[0]!.metric).toBe("");
    expect(result.nfrs[0]!.priority).toBe("should-have");
    expect(result.acceptanceCriteria[0]!.given).toBe("");
  });

  it("strips markdown fences", () => {
    const fenced =
      '```json\n{"nfrs":[{"category":"other","title":"t","description":"d"}],"acceptanceCriteria":[]}\n```';
    const result = parseNfrAcceptance(fenced)!;
    expect(result.nfrs).toHaveLength(1);
    expect(result.nfrs[0]!.category).toBe("other");
  });

  it("drops invalid items but keeps valid siblings", () => {
    const json = JSON.stringify({
      nfrs: [
        { category: "performance", title: "ok", description: "ok" },
        { category: "not-a-category", title: "bad", description: "bad enum" },
        { category: "security", title: "", description: "empty title" },
        "garbage",
      ],
      acceptanceCriteria: [{ statement: "valid" }, { statement: "" }, null],
    });
    const result = parseNfrAcceptance(json)!;
    expect(result.nfrs).toHaveLength(1);
    expect(result.nfrs[0]!.title).toBe("ok");
    expect(result.acceptanceCriteria).toHaveLength(1);
    expect(result.acceptanceCriteria[0]!.statement).toBe("valid");
  });

  // #1081 — an unreadable answer is `null`, never the empty answer.
  it("returns null, not an empty result, on non-JSON or wrong shape", () => {
    expect(parseNfrAcceptance("nope")).toBeNull();
    expect(parseNfrAcceptance(JSON.stringify(["array"]))).toBeNull();
    expect(parseNfrAcceptance(JSON.stringify({ other: 1 }))).toBeNull();
    expect(parseNfrAcceptance(JSON.stringify({ nfrs: "x", acceptanceCriteria: 3 }))).toBeNull();
  });

  it("reads a legitimately empty answer as empty", () => {
    expect(parseNfrAcceptance(JSON.stringify({ nfrs: [], acceptanceCriteria: [] }))).toEqual({
      nfrs: [],
      acceptanceCriteria: [],
    });
  });

  // #1613 — the sections an NFR is drawn from, kept as its evidence ids; a
  // malformed list reads as absent and never discards the NFR itself.
  it("reads an NFR's evidenceIds and fails soft on a malformed list", () => {
    const parsed = parseNfrAcceptance(
      JSON.stringify({
        nfrs: [
          { category: "performance", title: "Fast", description: "d", evidenceIds: ["f-1"] },
          { category: "security", title: "Safe", description: "d", evidenceIds: "f-2" },
        ],
      }),
    );
    expect(parsed?.nfrs.map((n) => n.evidenceIds)).toEqual([["f-1"], undefined]);
  });

  it("asks the model for each NFR's evidence ids", async () => {
    let system = "";
    await new NfrElicitor({
      provider: mockProvider(JSON.stringify({ nfrs: [], acceptanceCriteria: [] }), (m) => {
        system = String(m[0].content);
      }),
    }).elicit("### spec (id=f-1)\nfast");
    expect(system).toContain("evidenceIds");
  });
});

describe("NfrElicitor.elicit — #1081 unreadable answers", () => {
  it("re-prompts once, then returns the failure marked unread rather than 'no NFRs'", async () => {
    const provider = mockProvider("I could not find any NFRs, sorry.");
    const result = await new NfrElicitor({ provider }).elicit("The system must be fast.");
    expect(provider.chat).toHaveBeenCalledTimes(2);
    expect(result.unread).toMatchObject({ reason: "unparseable" });
    expect(result.nfrs).toEqual([]);
  });

  it("reads a null list as absent and keeps its sibling, in one call (panel finding)", async () => {
    const provider = mockProvider(
      JSON.stringify({ nfrs: null, acceptanceCriteria: [{ statement: "Login works." }] }),
    );
    const result = await new NfrElicitor({ provider }).elicit("The system must be fast.");
    expect(provider.chat).toHaveBeenCalledTimes(1);
    expect(result.unread).toBeUndefined();
    expect(result.acceptanceCriteria).toHaveLength(1);
  });

  it("treats a list with entries but none usable as unread, not as 'no NFRs' (#1081 review)", async () => {
    const provider = mockProvider(
      JSON.stringify({ nfrs: [{ name: "fast" }, { title: 7 }], acceptanceCriteria: [] }),
    );
    const result = await new NfrElicitor({ provider }).elicit("The system must be fast.");
    expect(provider.chat).toHaveBeenCalledTimes(2);
    expect(result.unread).toMatchObject({ reason: "schema-invalid" });
  });

  it("does not mark a legitimately empty answer unread", async () => {
    const provider = mockProvider(JSON.stringify({ nfrs: [], acceptanceCriteria: [] }));
    const result = await new NfrElicitor({ provider }).elicit("The system must be fast.");
    expect(provider.chat).toHaveBeenCalledTimes(1);
    expect(result.unread).toBeUndefined();
    expect(result.nfrs).toEqual([]);
  });

  it("returns a provider failure as unread instead of throwing", async () => {
    const provider = mockProvider("{}");
    (provider.chat as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("upstream 503"));
    const result = await new NfrElicitor({ provider }).elicit("The system must be fast.");
    expect(result.unread).toMatchObject({ reason: "provider-error" });
  });
});

describe("NfrElicitor.elicit", () => {
  it("returns empty without calling the model on blank input", async () => {
    const provider = mockProvider("{}");
    const elicitor = new NfrElicitor({ provider });
    const result = await elicitor.elicit("   ");
    expect(provider.chat).not.toHaveBeenCalled();
    expect(result.nfrs).toEqual([]);
    expect(result.usage.totalTokens).toBe(0);
  });

  it("elicits NFRs + ACs and disables tools", async () => {
    let captured: ChatMessage[] = [];
    const reply = JSON.stringify({
      nfrs: [{ category: "compliance", title: "GDPR", description: "Must comply with GDPR." }],
      acceptanceCriteria: [{ statement: "Data is deletable on request." }],
    });
    const provider = mockProvider(reply, (m) => {
      captured = m;
    });
    const elicitor = new NfrElicitor({ provider });
    const result = await elicitor.elicit("The system stores personal data.");

    const opts = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(opts.disableTools).toBe(true);
    expect(captured.map((c) => c.content).join("\n")).toContain("personal data");
    expect(result.nfrs[0]!.category).toBe("compliance");
    expect(result.acceptanceCriteria).toHaveLength(1);
    expect(result.usage.totalTokens).toBe(12);
  });

  it("passes the model override and abort signal through", async () => {
    const provider = mockProvider(JSON.stringify({ nfrs: [], acceptanceCriteria: [] }));
    const elicitor = new NfrElicitor({ provider, model: "custom" });
    const controller = new AbortController();
    await elicitor.elicit("input", controller.signal);
    expect(provider.chat).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ model: "custom", disableTools: true, signal: controller.signal }),
    );
  });
});
