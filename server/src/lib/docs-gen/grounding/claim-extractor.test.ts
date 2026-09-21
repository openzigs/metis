import { describe, it, expect, vi } from "vitest";
import { ClaimExtractor, stripDisclaimerBlocks } from "./claim-extractor.js";
import { buildGroundingContext } from "./grounding-context.js";
import type { AIProvider, ChatResponse } from "../../ai/types.js";

function mockProvider(content: string, opts?: { offline?: boolean }): AIProvider {
  const response: ChatResponse = {
    content,
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    model: "mock",
    provider: "offline-stub",
    offline: opts?.offline ?? false,
  };
  return {
    key: "offline-stub",
    model: "mock",
    offline: opts?.offline ?? false,
    chat: vi.fn().mockResolvedValue(response),
    stream: vi.fn(),
    embed: vi.fn(),
    models: vi.fn().mockResolvedValue(["mock"]),
    ping: vi.fn().mockResolvedValue(true),
  } as unknown as AIProvider;
}

const ctx = buildGroundingContext({
  ragChunks: [
    {
      documentId: "doc1",
      chunkId: "c1",
      filename: "Billing.java",
      text: "Invoices > 1000 need approval.",
    },
  ],
  webDigests: [
    {
      id: "d1",
      requirementId: "r1",
      evidenceNeedId: "e1",
      query: "approval",
      sources: [],
      digest: "Dual approval is common.",
      needsHumanReview: false,
    },
  ],
});

describe("ClaimExtractor.parseClaims", () => {
  const extractor = new ClaimExtractor({ provider: mockProvider("{}") });

  it("parses well-formed claims with citations", () => {
    const out = extractor.parseClaims(
      JSON.stringify({
        claims: [
          { claim: "Invoices over 1000 require approval.", sourceIds: ["rag:doc1:c1"] },
          { claim: "Dual approval is standard.", sourceIds: ["web:d1"] },
        ],
      }),
    );
    expect(out.claims).toHaveLength(2);
    expect(out.claims[0]).toEqual({
      claim: "Invoices over 1000 require approval.",
      sourceIds: ["rag:doc1:c1"],
    });
  });

  it("strips markdown fences before parsing", () => {
    const out = extractor.parseClaims(
      '```json\n{"claims":[{"claim":"X","sourceIds":["rag:doc1:c1"]}]}\n```',
    );
    expect(out.claims).toHaveLength(1);
    expect(out.claims[0].claim).toBe("X");
  });

  it("returns empty on unparseable JSON", () => {
    expect(extractor.parseClaims("not json at all").claims).toEqual([]);
  });

  it("recovers claims JSON wrapped in prose / a mid-response fence", () => {
    const out = extractor.parseClaims(
      'Sure — here is the decomposition:\n```json\n{"claims":[{"claim":"X","sourceIds":["rag:doc1:c1"]}]}\n```',
    );
    expect(out.claims).toHaveLength(1);
    expect(out.claims[0].claim).toBe("X");
  });

  it("returns empty when 'claims' is missing or not an array", () => {
    expect(extractor.parseClaims('{"foo":1}').claims).toEqual([]);
    expect(extractor.parseClaims('{"claims":"nope"}').claims).toEqual([]);
  });

  it("drops malformed claim entries via post-parse Zod", () => {
    const out = extractor.parseClaims(
      JSON.stringify({
        claims: [
          { claim: "", sourceIds: [] }, // empty claim -> dropped
          { claim: "valid", sourceIds: ["rag:doc1:c1"] },
          { claim: "missing ids" }, // missing sourceIds -> dropped
          { sourceIds: ["x"] }, // missing claim -> dropped
        ],
      }),
    );
    expect(out.claims).toHaveLength(1);
    expect(out.claims[0].claim).toBe("valid");
  });

  it("allows empty sourceIds (ungrounded claim, never fabricated)", () => {
    const out = extractor.parseClaims(
      JSON.stringify({ claims: [{ claim: "ungrounded", sourceIds: [] }] }),
    );
    expect(out.claims).toEqual([{ claim: "ungrounded", sourceIds: [] }]);
  });

  it("de-duplicates repeated source ids on a claim", () => {
    const out = extractor.parseClaims(
      JSON.stringify({
        claims: [{ claim: "c", sourceIds: ["rag:doc1:c1", "rag:doc1:c1"] }],
      }),
    );
    expect(out.claims[0].sourceIds).toEqual(["rag:doc1:c1"]);
  });
});

describe("ClaimExtractor.decompose", () => {
  it("calls provider.chat with disableTools and an enumerated source id list", async () => {
    const provider = mockProvider(
      JSON.stringify({
        claims: [{ claim: "Invoices need approval.", sourceIds: ["rag:doc1:c1"] }],
      }),
    );
    const extractor = new ClaimExtractor({ provider });
    const out = await extractor.decompose("Invoices over 1000 require approval.", ctx);

    expect(out.claims).toHaveLength(1);
    expect(provider.chat).toHaveBeenCalledTimes(1);
    const [messages, options] = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(options.disableTools).toBe(true);
    const userMsg = messages[1].content as string;
    expect(userMsg).toContain("rag:doc1:c1");
    expect(userMsg).toContain("web:d1");
    expect(userMsg).toContain("Invoices over 1000 require approval.");
  });

  it("requests prompt caching (system + messages) when promptCaching is enabled", async () => {
    const provider = mockProvider(JSON.stringify({ claims: [] }));
    const extractor = new ClaimExtractor({ provider, promptCaching: true });
    await extractor.decompose("Some claim.", ctx);
    const [, options] = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(options.promptCaching).toEqual({ system: true, messages: true });
  });

  it('tags the telemetry callType as "claim-extraction" (#701)', async () => {
    const provider = mockProvider(JSON.stringify({ claims: [] }));
    const extractor = new ClaimExtractor({ provider });
    await extractor.decompose("Some claim.", ctx);
    const [, options] = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(options.callType).toBe("claim-extraction");
  });

  it("does NOT request prompt caching by default (back-compat)", async () => {
    const provider = mockProvider(JSON.stringify({ claims: [] }));
    const extractor = new ClaimExtractor({ provider });
    await extractor.decompose("Some claim.", ctx);
    const [, options] = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(options.promptCaching).toBeUndefined();
  });

  it("forwards the responseFormat schema to provider.chat when supplied (#336)", async () => {
    const responseFormat = {
      type: "json_schema" as const,
      json_schema: { name: "claim_decomposition", schema: { type: "object" } },
    };
    const provider = mockProvider(JSON.stringify({ claims: [] }));
    const extractor = new ClaimExtractor({ provider, responseFormat });
    await extractor.decompose("Some claim.", ctx);
    const [, options] = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(options.responseFormat).toEqual(responseFormat);
  });

  it("does NOT send responseFormat by default (unchanged request)", async () => {
    const provider = mockProvider(JSON.stringify({ claims: [] }));
    const extractor = new ClaimExtractor({ provider });
    await extractor.decompose("Some claim.", ctx);
    const [, options] = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(options.responseFormat).toBeUndefined();
  });

  it("returns empty for blank input without calling the provider", async () => {
    const provider = mockProvider("{}");
    const extractor = new ClaimExtractor({ provider });
    const out = await extractor.decompose("   ", ctx);
    expect(out.claims).toEqual([]);
    expect(provider.chat).not.toHaveBeenCalled();
  });

  it("uses deterministic offline decomposition without a network call", async () => {
    const provider = mockProvider("UNUSED", { offline: true });
    const extractor = new ClaimExtractor({ provider });
    const out = await extractor.decompose(
      "## Heading\n- Invoices need approval.\n```code```\nManagers sign off.",
      ctx,
    );
    expect(provider.chat).not.toHaveBeenCalled();
    expect(out.claims.map((c) => c.claim)).toEqual([
      "Invoices need approval.",
      "Managers sign off.",
    ]);
    // Offline never fabricates citations.
    expect(out.claims.every((c) => c.sourceIds.length === 0)).toBe(true);
  });

  it("ignores disclaimer/admonition blockquotes, keeping only real claims (offline)", async () => {
    const provider = mockProvider("UNUSED", { offline: true });
    const extractor = new ClaimExtractor({ provider });
    const section = [
      "## Key Workflows",
      "> **Note:** many modules had empty bodies, so this section was reconstructed.",
      "> The system was developed by Potomac Economics.",
      "The settlement workflow reads raw exposures and writes a flagged dataset.",
      "> **Warning:** verify against source before relying on these steps.",
      "Records with a negative amount are excluded.",
    ].join("\n");
    const out = await extractor.decompose(section, ctx);
    expect(out.claims.map((c) => c.claim)).toEqual([
      "The settlement workflow reads raw exposures and writes a flagged dataset.",
      "Records with a negative amount are excluded.",
    ]);
  });

  it("strips blockquotes BEFORE building the LLM passage so disclaimers never reach the model", async () => {
    const provider = mockProvider(
      JSON.stringify({ claims: [{ claim: "real", sourceIds: ["rag:doc1:c1"] }] }),
    );
    const extractor = new ClaimExtractor({ provider });
    await extractor.decompose("> **Note:** empty bodies disclaimer.\nReal sentence stays.", ctx);
    const [messages] = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0];
    const passage = messages[1].content as string;
    expect(passage).toContain("Real sentence stays.");
    expect(passage).not.toContain("empty bodies disclaimer");
  });

  it("returns no claims (and no provider call) when the section is ONLY a disclaimer", async () => {
    const provider = mockProvider("UNUSED");
    const extractor = new ClaimExtractor({ provider });
    const out = await extractor.decompose(
      "> **Note:** this section could not be grounded.\n> All bodies were empty.",
      ctx,
    );
    expect(out.claims).toEqual([]);
    expect(provider.chat).not.toHaveBeenCalled();
  });
});

describe("stripDisclaimerBlocks", () => {
  it("removes leading blockquote callouts but keeps surrounding prose, bullets, and tables", () => {
    const md = [
      "Intro paragraph.",
      "> **Note:** a disclaimer.",
      "- a bullet item",
      "| Field | Type |",
      "| --- | --- |",
      "| id | string |",
    ].join("\n");
    const out = stripDisclaimerBlocks(md);
    expect(out).toContain("Intro paragraph.");
    expect(out).toContain("- a bullet item");
    expect(out).toContain("| Field | Type |");
    expect(out).toContain("| id | string |");
    expect(out).not.toContain("a disclaimer");
  });

  it("does NOT strip a mid-line `>` comparison (it is not a blockquote)", () => {
    const md = "Keep the record only when amount > 1000 and status = 'A'.";
    expect(stripDisclaimerBlocks(md)).toBe(md);
  });

  it("removes a multi-line blockquote and collapses the resulting blank gap", () => {
    const md = ["Before.", "> line one", "> line two", "", "After."].join("\n");
    const out = stripDisclaimerBlocks(md);
    expect(out).toContain("Before.");
    expect(out).toContain("After.");
    expect(out).not.toContain("line one");
    expect(out).not.toContain("line two");
    // No run of 3+ newlines should remain.
    expect(out).not.toMatch(/\n{3,}/);
  });

  it("strips indented and nested blockquotes", () => {
    const md = ["  > indented note", ">> nested note", "Real claim."].join("\n");
    const out = stripDisclaimerBlocks(md);
    expect(out.trim()).toBe("Real claim.");
  });
});
