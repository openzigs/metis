/**
 * Issue #2276 (panel fix) — the fused code query is bounded only where it
 * meets the embedder.
 *
 * The first cut sliced the composed query at 8,000 characters, so a long
 * import's later requirements left BOTH channels of the symbol search in
 * silence. These tests run the real `HybridCodeSearch` over the real composed
 * query: BM25 must still find the last requirement's symbol, the embedder must
 * never be handed more than the sidecar's per-text limit, and a requirement the
 * vector half could not read is named for the run's limits.
 */
import { describe, expect, it } from "vitest";
import {
  HybridCodeSearch,
  MAX_VECTOR_QUERY_CHARS,
  type SearchableSymbol,
  type SymbolIndex,
  type SymbolVectorStore,
  type VectorSearchHit,
} from "../code-graph/hybrid-search.js";
import type { EmbedService } from "../code-graph/symbol-embeddings.js";
import { MAX_EMBED_TEXT_CHARS } from "../rag/embed-model-config.js";
import { composeCodeAgentFusedQuery, fusedSemanticLeftOut } from "./fused-code-chunks.js";
import { MAX_REQUIREMENT_QUERY_CHARS, requirementQueryText } from "./requirement-query.js";

function symbol(symbolId: string, name: string): SearchableSymbol {
  return {
    symbolId,
    name,
    qualifiedName: `app.${name}`,
    kind: "function",
    filePath: `src/${name}.ts`,
  };
}

const SYMBOLS: SearchableSymbol[] = [
  symbol("decoy-1", "renderInvoice"),
  symbol("decoy-2", "sendEmail"),
  symbol("decoy-3", "parseConfig"),
  // Only the LAST requirement names this one.
  symbol("target", "reconcileZanzibarLedger"),
  // Reachable only through the vector channel.
  symbol("vector-only", "computeChecksum"),
];

const index: SymbolIndex = { getSymbols: async () => SYMBOLS };

/** Mirrors the sidecar: an input over its per-text limit is a 400, not a cut. */
class SidecarLikeEmbed implements EmbedService {
  readonly lengths: number[] = [];
  async embed(texts: string[]) {
    for (const t of texts) {
      this.lengths.push(t.length);
      if (t.length > MAX_EMBED_TEXT_CHARS) throw new Error("400: text exceeds limit");
    }
    return { vectors: texts.map(() => [1, 0, 0]), model: "m", dimension: 3 };
  }
}

const vectorStore: SymbolVectorStore = {
  search: async (): Promise<VectorSearchHit[]> => [
    {
      score: 0.9,
      metadata: { symbolId: "vector-only", filePath: "src/computeChecksum.ts" },
    } as unknown as VectorSearchHit,
  ],
};

/** `n` requirements of filler that matches no symbol; the last one names the target. */
function requirements(n: number, fillerChars: number): Array<{ id: string; text: string }> {
  const filler = "the analyst records quarterly figures in plain prose ".repeat(
    Math.ceil(fillerChars / 52),
  );
  return Array.from({ length: n }, (_, i) => ({
    id: `REQ-${i + 1}`,
    text:
      i === n - 1
        ? `Reconcile the Zanzibar ledger nightly. ${filler.slice(0, fillerChars)}`
        : `Requirement ${i + 1}. ${filler.slice(0, fillerChars)}`,
  }));
}

function compose(reqs: Array<{ id: string; text: string }>) {
  return composeCodeAgentFusedQuery({
    projectName: "Acme",
    requirementTexts: reqs.map((r) => requirementQueryText(r.text)),
  });
}

describe("#2276 — the fused code query is bounded only for the embedder", () => {
  it("a 24-item import (~19k characters) keeps every requirement in the query BM25 scores", async () => {
    const reqs = requirements(24, 760);
    const { query, requirementEnds } = compose(reqs);
    expect(query.length).toBeGreaterThan(18_000);
    expect(query.length).toBeLessThan(MAX_VECTOR_QUERY_CHARS);
    expect(query).toContain("Zanzibar");

    const embed = new SidecarLikeEmbed();
    const results = await new HybridCodeSearch(vectorStore, index, embed).search(query, "p");
    const ids = results.map((r) => r.symbolId);
    expect(ids).toContain("target");
    expect(ids).toContain("vector-only");
    expect(embed.lengths).toEqual([query.length]);
    // Nothing past the embedder's limit, so nothing is reported.
    expect(fusedSemanticLeftOut(reqs, requirementEnds)).toBeNull();
  });

  it("a query past the embedder's limit: BM25 still reads the last requirement, the embedder gets at most its limit", async () => {
    const reqs = requirements(24, MAX_REQUIREMENT_QUERY_CHARS);
    const { query, requirementEnds } = compose(reqs);
    expect(query.length).toBeGreaterThan(MAX_EMBED_TEXT_CHARS);

    const embed = new SidecarLikeEmbed();
    const results = await new HybridCodeSearch(vectorStore, index, embed).search(query, "p");
    const ids = results.map((r) => r.symbolId);
    expect(ids).toContain("target");
    // The vector channel survived: it was given its head, not refused.
    expect(ids).toContain("vector-only");
    expect(embed.lengths).toEqual([MAX_VECTOR_QUERY_CHARS]);
    expect(MAX_VECTOR_QUERY_CHARS).toBe(MAX_EMBED_TEXT_CHARS);

    // …and the requirements the vector half did not read are named.
    const notice = fusedSemanticLeftOut(reqs, requirementEnds);
    expect(notice).not.toBeNull();
    expect(notice!.stage).toBe("fused-code-semantic");
    expect(notice!.totalCount).toBe(24);
    expect(notice!.analysedCount + notice!.leftOut.length).toBe(24);
    // Each requirement is ~4,002 characters with its separator: 8 fit in 32,768.
    expect(notice!.analysedCount).toBe(8);
    expect(notice!.leftOut.at(-1)!.id).toBe("REQ-24");
    expect(notice!.leftOut[0]!.id).toBe("REQ-9");
  });

  it("requirementEnds skips empty texts and a requirement ending exactly at the limit fits", () => {
    const { query, requirementEnds } = composeCodeAgentFusedQuery({
      requirementTexts: ["abc", "  ", "de"],
    });
    expect(query).toBe("abc. de");
    expect(requirementEnds).toEqual([3, null, 7]);
    const reqs = [
      { id: "A", text: "abc" },
      { id: "B", text: "  " },
      { id: "C", text: "de" },
    ];
    expect(fusedSemanticLeftOut(reqs, requirementEnds, 7)).toBeNull();
    expect(fusedSemanticLeftOut(reqs, requirementEnds, 6)).toEqual({
      stage: "fused-code-semantic",
      analysedCount: 1,
      totalCount: 2,
      leftOut: [{ id: "C", excerpt: "de" }],
    });
  });
});
