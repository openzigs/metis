/**
 * #165 — follow-ups from the review of #162 (claim batching): bounded
 * re-splitting, oversized and unclosed fences, partial claim lists, and the
 * parent heading of a split passage.
 */
import { describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatMessage, ChatOptions } from "../../ai/types.js";
import { ClaimExtractor, splitForClaimExtraction } from "./claim-extractor.js";
import { scoreFaithfulness } from "./citation-validator.js";
import { groundingUnparseableWarning } from "./degraded-warnings.js";
import { buildGroundingContext } from "./grounding-context.js";
import { scoreFaithfulnessSampled } from "./grounding-mode.js";

const ctx = buildGroundingContext({
  ragChunks: [{ documentId: "doc1", chunkId: "c1", filename: "Rates.sas", text: "rate = 0.05;" }],
});

function passageOf(messages: ChatMessage[]): string {
  const user = String(messages[1].content);
  return user.split("=== PASSAGE ===\n")[1].split("\n=== END PASSAGE ===")[0];
}

/** One claim per non-heading, non-fence line; `fail(passage)` decides a failed reply. */
function scriptedProvider(fail: (passage: string) => "length" | "prose" | null = () => null) {
  const passages: string[] = [];
  const provider = {
    key: "local-test",
    model: "test-model",
    offline: false,
    chat: vi.fn(async (messages: ChatMessage[], _opts: ChatOptions = {}) => {
      const passage = passageOf(messages);
      passages.push(passage);
      const failure = fail(passage);
      if (failure === "length") return { content: '{"claims":[', finishReason: "length" };
      if (failure === "prose") return { content: "I cannot do that.", finishReason: "stop" };
      const claims = passage
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#") && !/^(`{3,}|~{3,})/.test(l))
        .map((l) => ({ claim: l.replace(/^[-*]\s+/, ""), sourceIds: ["rag:doc1:c1"] }));
      return { content: JSON.stringify({ claims }), finishReason: "stop" };
    }),
  } as unknown as AIProvider;
  return { provider, passages };
}

const lines = (n: number, tag: string) =>
  Array.from({ length: n }, (_, i) => `- ${tag} rule ${i}: the rate is applied to tier ${i}.`);

describe("ClaimExtractor — bounded re-splitting (#165 item 1)", () => {
  it("a passage cut off on every reply costs at most 2 calls", async () => {
    const { provider, passages } = scriptedProvider(() => "length");
    const extractor = new ClaimExtractor({ provider });
    const section = lines(150, "loop").join("\n");
    expect(section.length).toBeGreaterThan(4_000);
    expect(section.length).toBeLessThan(8_000); // one batch
    const result = await extractor.decompose(section, ctx);
    expect(passages).toHaveLength(2);
    expect(passages[1].length).toBeLessThan(passages[0].length);
    expect(result).toEqual({ claims: [], unparseable: true, truncated: true });
  });

  it("a passage that fits after one split still yields every claim", async () => {
    // Cut off only when the passage is over 5,000 chars: the whole is, halves are not.
    const { provider, passages } = scriptedProvider((p) => (p.length > 5_000 ? "length" : null));
    const extractor = new ClaimExtractor({ provider });
    const section = lines(150, "fit").join("\n");
    const result = await extractor.decompose(section, ctx);
    expect(result.unparseable).toBeUndefined();
    expect(result.claims).toHaveLength(150);
    expect(passages.length).toBeGreaterThanOrEqual(3);
    expect(passages.slice(1).every((p) => p.length <= 5_000)).toBe(true);
  });
});

describe("splitForClaimExtraction — fences (#165 item 2)", () => {
  it("splits a 20k-char fenced block within the budget, each piece a closed fence", () => {
    const code = Array.from({ length: 800 }, (_, i) => `p${i} = base${i} * (1 + r${i});`);
    const fence = ["```sas", ...code, "```"].join("\n");
    expect(fence.length).toBeGreaterThan(20_000);
    const text = `### Premium formula\n\nThe premium is computed as:\n\n${fence}\n\nAfter the fence.`;
    const chunks = splitForClaimExtraction(text, 8_000);
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(8_000);
    // Every code line survives, in order.
    const seen = chunks
      .join("\n")
      .split("\n")
      .filter((l) => /^p\d+ = /.test(l));
    expect(seen).toEqual(code);
    // Each piece holding code opens and closes its own fence.
    for (const c of chunks.filter((c) => /^p\d+ = /m.test(c))) {
      const markers = c.split("\n").filter((l) => l.startsWith("```"));
      expect(markers[0]).toBe("```sas");
      expect(markers).toHaveLength(2);
    }
  });

  it("an unclosed fence does not swallow the rest of the section as one passage", () => {
    const before = lines(40, "before").join("\n");
    const after = lines(400, "after").join("\n");
    const text = `### Rules\n\n${before}\n\n\`\`\`sql\nSELECT 1\n\n${after}`;
    expect(text.length).toBeGreaterThan(20_000);
    const chunks = splitForClaimExtraction(text, 8_000);
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(8_000);
    const all = chunks.join("\n");
    for (const l of [...lines(40, "before"), ...lines(400, "after")]) expect(all).toContain(l);
  });

  it("an unclosed opener is read as a plain line, so later subsections still split at their headings", () => {
    const after = Array.from({ length: 6 }, (_, k) =>
      [`### Later ${k}`, "", lines(40, `later${k}`).join("\n")].join("\n"),
    ).join("\n\n");
    const text = `### Rules\n\n\`\`\`sql\nSELECT 1\n\n${after}`;
    const chunks = splitForClaimExtraction(text, 4_000);
    expect(chunks.some((c) => c.startsWith("### Later 3"))).toBe(true);
    // Never re-opened as a fence around the prose that follows it.
    expect(chunks.join("\n").split("```sql")).toHaveLength(2);
  });

  it("an unclosed fence inside one oversized paragraph is split within the budget", () => {
    const text = ["```sql", ...lines(600, "code")].join("\n");
    expect(text.length).toBeGreaterThan(20_000);
    const chunks = splitForClaimExtraction(text, 8_000);
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(8_000);
  });
});

describe("ClaimExtractor — partial claims (#165 item 4)", () => {
  it("keeps the claims of the half that parsed when the other half is cut off", async () => {
    const section = [...lines(75, "head"), ...lines(75, "LOOPING")].join("\n");
    const { provider, passages } = scriptedProvider((p) =>
      p.length > 5_000 || p.includes("LOOPING rule 74:") ? "length" : null,
    );
    const extractor = new ClaimExtractor({ provider });
    const result = await extractor.decompose(section, ctx);
    expect(passages.length).toBeGreaterThanOrEqual(3);
    expect(result.unparseable).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.claims.filter((c) => c.claim.startsWith("head"))).not.toHaveLength(0);
    expect(result.claims.some((c) => c.claim.startsWith("LOOPING rule 74:"))).toBe(false);
  });

  it("claims from successful passages survive one failed passage", async () => {
    const good1 = lines(90, "alpha").join("\n");
    const bad = lines(90, "BROKEN").join("\n");
    const good2 = lines(90, "omega").join("\n");
    const section = `### A\n\n${good1}\n\n### B\n\n${bad}\n\n### C\n\n${good2}`;
    const { provider } = scriptedProvider((p) => (p.includes("BROKEN") ? "prose" : null));
    const extractor = new ClaimExtractor({ provider, batchChars: 5_000 });
    const result = await extractor.decompose(section, ctx);
    expect(result.unparseable).toBe(true);
    expect(result.truncated).toBeUndefined();
    const text = result.claims.map((c) => c.claim);
    expect(text.filter((c) => c.startsWith("alpha"))).toHaveLength(90);
    expect(text.filter((c) => c.startsWith("omega"))).toHaveLength(90);
    expect(text.some((c) => c.startsWith("BROKEN"))).toBe(false);
  });

  it("the kept claims are judged, and the result still says part went unchecked", async () => {
    const result = await scoreFaithfulness("Rules", "text", ctx, {
      extractor: {
        decompose: async () => ({
          claims: [{ claim: "c1", sourceIds: [] }],
          unparseable: true as const,
          truncated: true as const,
        }),
      },
      judge: {
        judge: async (claims) => claims.map((claim) => ({ claim, supported: true, sourceIds: [] })),
      },
    });
    expect(result.verified).toBe(true);
    expect(result.totalClaims).toBe(1);
    expect(result.unparseable).toBe("claims");
    expect(result.truncated).toBe(true);
  });

  it("sample mode keeps the claims of an earlier draw when a top-up draw fails", async () => {
    const section = Array.from({ length: 20 }, (_, i) => lines(3, `p${i}`).join("\n")).join("\n\n");
    const replies = [
      { claims: [{ claim: "kept", sourceIds: [] }] },
      { claims: [], unparseable: true as const, truncated: true as const },
    ];
    const result = await scoreFaithfulnessSampled(
      "Rules",
      section,
      ctx,
      {
        extractor: { decompose: async () => replies.shift()! },
        judge: {
          judge: async (claims) =>
            claims.map((claim) => ({ claim, supported: true, sourceIds: [] })),
        },
      },
      { rate: 0.25, minClaims: 3 },
    );
    expect(replies).toHaveLength(0);
    expect(result.verified).toBe(true);
    expect(result.totalClaims).toBe(1);
    expect(result.unparseable).toBe("claims");
    expect(result.truncated).toBe(true);
    expect(result.sampled?.passagesChecked).toBeLessThan(20);
  });

  it("the partial warning says the other passages were checked, and unsent ones were not", () => {
    const w = groundingUnparseableWarning("Rules", "claims", "truncated", true);
    expect(w.message).toContain("for part of the section");
    expect(w.message).toContain("the other passages' were");
    // PR #281 review — after two failures in a row the rest is never sent.
    expect(w.message).toContain("not sent after repeated failures");
    expect(w.message).not.toContain("the rest were");
    expect(w.message).not.toContain("none of its statements");
    const whole = groundingUnparseableWarning("Rules", "claims");
    expect(whole.message).toContain("none of its statements");
  });
});

describe("split passages carry their parent heading (#165 item 5)", () => {
  it("each passage of a long subsection starts with its heading", () => {
    const text = `### Tier rules\n\n${lines(200, "tier").join("\n\n")}`;
    const chunks = splitForClaimExtraction(text, 2_000);
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) {
      expect(c.startsWith("### Tier rules\n")).toBe(true);
      expect(c.length).toBeLessThanOrEqual(2_000);
    }
  });

  it("the pieces of one oversized paragraph also carry it", () => {
    const text = `### Tier rules\n\n${lines(200, "tier").join("\n")}`;
    const chunks = splitForClaimExtraction(text, 2_000);
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(c.startsWith("### Tier rules\n")).toBe(true);
  });

  it("both halves of a passage split after a cut-off reply are asked with the heading", async () => {
    const { provider, passages } = scriptedProvider((p) => (p.length > 5_000 ? "length" : null));
    const extractor = new ClaimExtractor({ provider });
    const section = `### Tier rules\n\n${lines(150, "tier").join("\n")}`;
    await extractor.decompose(section, ctx);
    expect(passages.length).toBeGreaterThanOrEqual(3);
    for (const p of passages) expect(p.startsWith("### Tier rules\n")).toBe(true);
  });
});
