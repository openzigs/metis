import { describe, it, expect } from "vitest";
import {
  buildGroundingContext,
  renderGroundingBlock,
  ragSourceId,
  webSourceId,
  factsSourceId,
  mergeFactsIntoContext,
  ragChunkFromMetadata,
  type RagChunk,
  type FactsSourceInput,
} from "./grounding-context.js";
import type { EvidenceDigest } from "../../analysis/types/requirements.js";
import type { VectorMetadata } from "../../rag/vector-store.js";

function chunk(over: Partial<RagChunk> = {}): RagChunk {
  return {
    documentId: "doc1",
    chunkId: "c1",
    filename: "Billing.java",
    text: "Invoices over 1000 require manager approval.",
    ...over,
  };
}

function digest(over: Partial<EvidenceDigest> = {}): EvidenceDigest {
  return {
    id: "d1",
    requirementId: "r1",
    evidenceNeedId: "e1",
    query: "invoice approval thresholds",
    sources: [
      {
        url: "https://nist.gov/spec",
        title: "NIST",
        excerpt: "...",
        relevanceScore: 0.9,
        domainTrust: "high",
      },
    ],
    digest: "Industry practice: invoices above a threshold need dual approval.",
    needsHumanReview: false,
    ...over,
  };
}

function fact(over: Partial<FactsSourceInput> = {}): FactsSourceInput {
  return {
    moduleDir: "sas/etl",
    idx: 0,
    label: "sas/etl",
    text: "PURPOSE\nLoads and cleans claims data via the CLEAN macro.",
    ...over,
  };
}

describe("source id helpers", () => {
  it("builds stable rag and web ids", () => {
    expect(ragSourceId("doc1", "c1")).toBe("rag:doc1:c1");
    expect(webSourceId("d1")).toBe("web:d1");
  });

  it("builds stable facts ids that sanitise the module dir", () => {
    expect(factsSourceId("sas/etl", 0)).toBe("facts:sas_etl:0");
    expect(factsSourceId("src/main/java", 3)).toBe("facts:src_main_java:3");
  });

  it("sanitises unusual characters in the module dir to keep the id parseable", () => {
    // Colons/spaces/backslashes would break the `kind:rest` id grammar.
    expect(factsSourceId("a b:c\\d", 1)).toBe("facts:a_b_c_d:1");
  });

  it("produces stable (deterministic) ids for the same input", () => {
    expect(factsSourceId("sas/etl", 2)).toBe(factsSourceId("sas/etl", 2));
  });

  it("converts VectorMetadata to a RagChunk", () => {
    const meta: VectorMetadata = {
      documentId: "doc9",
      chunkId: "c9",
      filename: "F.ts",
      position: 0,
      text: "hello",
      embeddingModel: "m",
    };
    expect(ragChunkFromMetadata(meta)).toEqual({
      documentId: "doc9",
      chunkId: "c9",
      filename: "F.ts",
      text: "hello",
    });
  });
});

describe("buildGroundingContext", () => {
  it("preserves reference classes and distinguishes opt-in web references", () => {
    const ctx = buildGroundingContext({
      ragChunks: [
        chunk({ evidenceClass: "project-reference" }),
        chunk({ chunkId: "c2", evidenceClass: "repository-source" }),
      ],
      webDigests: [digest()],
    });
    expect(ctx.sources.map((s) => s.evidenceClass)).toEqual([
      "project-reference",
      "repository-source",
      "web-reference",
    ]);
    expect(mergeFactsIntoContext(ctx, [fact()]).sources.slice(1)).toEqual(ctx.sources);
  });

  it("handles missing legacy labels, text and identifiers without inventing evidence", () => {
    const ctx = buildGroundingContext({
      charBudget: -1,
      ragChunks: [
        chunk({ chunkId: "" }),
        chunk({ text: undefined as unknown as string }),
        chunk({ filename: undefined, chunkId: "kept" }),
      ],
      factsSources: [fact({ label: undefined, text: undefined as unknown as string })],
      webDigests: [
        digest({ id: "" }),
        digest({ id: "empty", digest: undefined as unknown as string }),
        digest({ query: undefined as unknown as string, sources: [] }),
      ],
    });
    expect(ctx.sources.map((s) => s.sourceId)).toEqual(["rag:doc1:kept", "web:d1"]);
    expect(ctx.sources.map((s) => s.label)).toEqual(["doc1/kept", "web:d1"]);
    expect(factsSourceId("///", 0)).toBe("facts:module:0");
  });
  it("assembles RAG chunks before web digests with stable ids", () => {
    const ctx = buildGroundingContext({ ragChunks: [chunk()], webDigests: [digest()] });
    expect(ctx.isEmpty).toBe(false);
    expect(ctx.sources.map((s) => s.sourceId)).toEqual(["rag:doc1:c1", "web:d1"]);
    expect(ctx.sources[0].kind).toBe("rag");
    expect(ctx.sources[1].kind).toBe("web");
    expect(ctx.sourceIds.has("rag:doc1:c1")).toBe(true);
    expect(ctx.sourceIds.has("web:d1")).toBe(true);
  });

  it("preserves RAG documentId/chunkId on the source for citation resolution", () => {
    const ctx = buildGroundingContext({ ragChunks: [chunk()] });
    expect(ctx.sources[0].documentId).toBe("doc1");
    expect(ctx.sources[0].chunkId).toBe("c1");
  });

  it("returns empty when nothing is provided", () => {
    const ctx = buildGroundingContext({});
    expect(ctx.isEmpty).toBe(true);
    expect(ctx.sources).toHaveLength(0);
    expect(ctx.sourceIds.size).toBe(0);
  });

  it("drops whitespace-only and missing-id sources", () => {
    const ctx = buildGroundingContext({
      ragChunks: [
        chunk({ text: "   " }),
        chunk({ documentId: "", chunkId: "x", text: "no id" }),
        chunk({ documentId: "ok", chunkId: "ok", text: "kept" }),
      ],
      webDigests: [digest({ id: "d2", digest: "" })],
    });
    expect(ctx.sources.map((s) => s.sourceId)).toEqual(["rag:ok:ok"]);
  });

  it("de-duplicates identical source ids (first wins)", () => {
    const ctx = buildGroundingContext({
      ragChunks: [chunk({ text: "first" }), chunk({ text: "second" })],
    });
    expect(ctx.sources).toHaveLength(1);
    expect(ctx.sources[0].text).toBe("first");
  });

  it("honours the char budget but always admits at least one source", () => {
    const big = "x".repeat(500);
    const ctx = buildGroundingContext({
      ragChunks: [
        chunk({ documentId: "a", chunkId: "a", text: big }),
        chunk({ documentId: "b", chunkId: "b", text: big }),
        chunk({ documentId: "c", chunkId: "c", text: big }),
      ],
      charBudget: 600,
    });
    // first admitted unconditionally; second would push to 1000 > 600 -> dropped
    expect(ctx.sources.map((s) => s.sourceId)).toEqual(["rag:a:a"]);
  });

  it("labels web digests by host when available", () => {
    const ctx = buildGroundingContext({ webDigests: [digest()] });
    expect(ctx.sources[0].label).toBe("web:nist.gov");
  });

  it("falls back to query label when a digest has no usable source url", () => {
    const ctx = buildGroundingContext({
      webDigests: [digest({ sources: [], query: "fallback query" })],
    });
    expect(ctx.sources[0].label).toContain("fallback query");
  });

  it("falls back to query label when the source url is malformed", () => {
    const ctx = buildGroundingContext({
      webDigests: [
        digest({
          query: "malformed url case",
          sources: [
            { url: "not a url", title: "t", excerpt: "x", relevanceScore: 0.1, domainTrust: "low" },
          ],
        }),
      ],
    });
    expect(ctx.sources[0].label).toContain("malformed url case");
  });
});

describe("buildGroundingContext — facts sources (#267)", () => {
  it("admits facts sources with stable ids", () => {
    const ctx = buildGroundingContext({ factsSources: [fact()] });
    expect(ctx.isEmpty).toBe(false);
    expect(ctx.sources[0].sourceId).toBe("facts:sas_etl:0");
    expect(ctx.sources[0].kind).toBe("facts");
    expect(ctx.sourceIds.has("facts:sas_etl:0")).toBe(true);
  });

  it("orders facts BEFORE rag and web (facts are closest to synthesized claims)", () => {
    const ctx = buildGroundingContext({
      ragChunks: [chunk()],
      webDigests: [digest()],
      factsSources: [fact()],
    });
    expect(ctx.sources.map((s) => s.kind)).toEqual(["facts", "rag", "web"]);
  });

  it("preserves the actual fact text so a claim can match/cite it", () => {
    const ctx = buildGroundingContext({
      factsSources: [fact({ text: "RULES\nClaims above 1000 require manual review." })],
    });
    expect(ctx.sources[0].text).toContain("Claims above 1000 require manual review.");
  });

  it("de-duplicates identical facts ids (first wins)", () => {
    const ctx = buildGroundingContext({
      factsSources: [fact({ text: "first" }), fact({ text: "second" })],
    });
    expect(ctx.sources).toHaveLength(1);
    expect(ctx.sources[0].text).toBe("first");
  });

  it("drops whitespace-only facts text", () => {
    const ctx = buildGroundingContext({ factsSources: [fact({ text: "   " })] });
    expect(ctx.isEmpty).toBe(true);
  });

  it("counts facts against the shared char budget (facts admitted first)", () => {
    const big = "y".repeat(500);
    const ctx = buildGroundingContext({
      factsSources: [fact({ idx: 0, text: big }), fact({ idx: 1, text: big })],
      ragChunks: [chunk({ documentId: "a", chunkId: "a", text: big })],
      charBudget: 600,
    });
    // First facts source admitted unconditionally; the next would exceed 600 → dropped.
    expect(ctx.sources.map((s) => s.sourceId)).toEqual(["facts:sas_etl:0"]);
  });
});

describe("mergeFactsIntoContext (#267)", () => {
  it("drops empty and duplicate facts and applies the facts-only budget", () => {
    const base = buildGroundingContext({
      factsSources: [fact({ text: "duplicate" })],
      ragChunks: [chunk()],
    });
    const merged = mergeFactsIntoContext(
      base,
      [
        fact({ text: undefined as unknown as string, label: undefined }),
        fact({ text: "first" }),
        fact({ text: "duplicate" }),
        fact({ idx: 1, text: "over budget" }),
      ],
      5,
    );
    expect(merged.sources.map((s) => s.text)).toEqual(["first", chunk().text]);
    expect(mergeFactsIntoContext(undefined, []).isEmpty).toBe(true);
  });
  it("returns the original context unchanged when no facts are supplied", () => {
    const base = buildGroundingContext({ ragChunks: [chunk()] });
    const merged = mergeFactsIntoContext(base, []);
    expect(merged).toBe(base);
  });

  it("merges facts into an existing rag context, facts first then rag", () => {
    const base = buildGroundingContext({ ragChunks: [chunk()] });
    const merged = mergeFactsIntoContext(base, [fact()]);
    expect(merged).not.toBe(base);
    expect(merged.sources.map((s) => s.kind)).toEqual(["facts", "rag"]);
    expect(merged.sourceIds.has("facts:sas_etl:0")).toBe(true);
    expect(merged.sourceIds.has("rag:doc1:c1")).toBe(true);
  });

  it("builds a facts-only context when the base is empty/undefined", () => {
    const merged = mergeFactsIntoContext(undefined, [fact()]);
    expect(merged.isEmpty).toBe(false);
    expect(merged.sources.map((s) => s.kind)).toEqual(["facts"]);
  });

  it("does not mutate the original context", () => {
    const base = buildGroundingContext({ ragChunks: [chunk()] });
    const beforeIds = [...base.sourceIds];
    mergeFactsIntoContext(base, [fact()]);
    expect([...base.sourceIds]).toEqual(beforeIds);
  });
});

describe("renderGroundingBlock", () => {
  it("returns empty string for empty context", () => {
    expect(renderGroundingBlock(buildGroundingContext({}))).toBe("");
  });

  it("renders facts sources with their ids so the claim-extractor can cite them", () => {
    const ctx = buildGroundingContext({ factsSources: [fact()] });
    const block = renderGroundingBlock(ctx);
    expect(block).toContain("id=facts:sas_etl:0");
    expect(block).toContain("kind=facts");
    expect(block).toContain("CLEAN macro");
  });

  it("renders each source with its id and text so the model can cite it", () => {
    const ctx = buildGroundingContext({ ragChunks: [chunk()], webDigests: [digest()] });
    const block = renderGroundingBlock(ctx);
    expect(block).toContain("RETRIEVED GROUNDING SOURCES");
    expect(block).toContain("id=rag:doc1:c1");
    expect(block).toContain("id=web:d1");
    expect(block).toContain("Invoices over 1000 require manager approval.");
    expect(block).toContain("dual approval");
    expect(block).toContain("END GROUNDING SOURCES");
  });
});
