/**
 * Issue #729 (Epic #725) — fused code-graph symbol chunks for analysis
 * `retrieveContext`.
 *
 * Covers the contracts the orchestrator's code-agent branch relies on:
 *   (a) flag off (explicit `enabled:false` OR `ANALYSIS_FUSED_CODE_RETRIEVAL=false`)
 *       ⇒ `[]` AND the searcher is never queried — the pre-#729 behaviour is
 *       reproduced byte-for-byte. NOTE: as of #752 the CONFIG DEFAULT is ON, so
 *       an unset flag now DOES query the searcher (see the default-on test);
 *   (b) flag on ⇒ symbol hits map to `RetrievalContextChunk`s carrying
 *       `filePath:startLine-endLine` provenance for Epic #726 citations;
 *   (c) hits already covered by a source-as-RAG chunk are deduped;
 *   (d) the token budget truncates the ranked tail deterministically;
 *   (e) searcher/lookup failure or a missing code graph ⇒ clean `[]`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetConfigSingleton } from "../config/config-service.js";
import { RETRIEVAL_QUERIES } from "./retrieval.js";
import type {
  FusedCodeSearcher,
  FusedSymbolHit,
  RawCodeSymbolHit,
  SymbolLineLookup,
} from "../rag/fused-code-context.js";
import {
  buildCodeAgentFusedQuery,
  CODE_GRAPH_DOCUMENT_PREFIX,
  estimateFusedBlockTokens,
  renderFusedCodeContextBlock,
  retrieveFusedCodeChunks,
  retrieveFusedCodeContext,
  symbolHitToContextChunk,
} from "./fused-code-chunks.js";

function rawHit(overrides: Partial<RawCodeSymbolHit> = {}): RawCodeSymbolHit {
  return {
    symbolId: "sym-1",
    filePath: "src/lib/auth/login.ts",
    name: "loginUser",
    kind: "function",
    score: 0.9,
    snippet: "export function loginUser() {}",
    ...overrides,
  };
}

function makeSearcher(
  hits: RawCodeSymbolHit[],
): FusedCodeSearcher & { search: ReturnType<typeof vi.fn> } {
  return { search: vi.fn(async () => hits) };
}

function makeLineLookup(
  spans: Record<string, { filePath: string; startLine: number; endLine: number }>,
): SymbolLineLookup {
  return {
    resolve: async (ids: string[]) =>
      new Map(ids.filter((id) => spans[id]).map((id) => [id, spans[id]])),
  };
}

const spans = {
  "sym-1": { filePath: "src/lib/auth/login.ts", startLine: 12, endLine: 48 },
  "sym-2": { filePath: "src/lib/auth/session.ts", startLine: 5, endLine: 30 },
};

afterEach(() => {
  vi.unstubAllEnvs();
  __resetConfigSingleton();
});

describe("symbolHitToContextChunk (#729)", () => {
  it("maps a symbol hit to a RetrievalContextChunk with full provenance", () => {
    const hit: FusedSymbolHit = {
      symbolId: "sym-9",
      filePath: "src/a.ts",
      startLine: 3,
      endLine: 17,
      name: "Foo",
      kind: "class",
      score: 0.75,
      snippet: "class Foo {}",
    };
    const chunk = symbolHitToContextChunk(hit);
    expect(chunk).toEqual({
      documentId: `${CODE_GRAPH_DOCUMENT_PREFIX}sym-9`,
      chunkIndex: 0,
      filename: "src/a.ts",
      text: "Foo (class) — src/a.ts:3-17\nclass Foo {}",
      score: 0.75,
      source: "code-graph",
      symbolId: "sym-9",
      filePath: "src/a.ts",
      startLine: 3,
      endLine: 17,
    });
  });

  it("renders the locator-only text when the hit has no snippet", () => {
    const chunk = symbolHitToContextChunk({
      symbolId: "sym-9",
      filePath: "src/a.ts",
      startLine: 3,
      endLine: 17,
      name: "Foo",
      kind: "class",
      score: 1,
      snippet: null,
    });
    expect(chunk.text).toBe("Foo (class) — src/a.ts:3-17");
  });
});

describe("retrieveFusedCodeChunks — flag off (AC: regression)", () => {
  it("returns [] and never queries the searcher when explicitly disabled", async () => {
    const searcher = makeSearcher([rawHit()]);
    const chunks = await retrieveFusedCodeChunks({
      projectId: "proj-1",
      query: "auth login",
      ragChunks: [],
      enabled: false,
      tokenBudget: 1500,
      maxSymbols: 12,
      deps: { searcher, lineLookup: makeLineLookup(spans) },
    });
    expect(chunks).toEqual([]);
    expect(searcher.search).not.toHaveBeenCalled();
  });

  it("stays disabled when ANALYSIS_FUSED_CODE_RETRIEVAL=false (operator opt-out, tunable)", async () => {
    vi.stubEnv("ANALYSIS_FUSED_CODE_RETRIEVAL", "false");
    __resetConfigSingleton();
    const searcher = makeSearcher([rawHit()]);
    const chunks = await retrieveFusedCodeChunks({
      projectId: "proj-1",
      query: "auth login",
      ragChunks: [],
      deps: { searcher, lineLookup: makeLineLookup(spans) },
    });
    expect(chunks).toEqual([]);
    expect(searcher.search).not.toHaveBeenCalled();
  });

  it("defaults to ENABLED via ANALYSIS_FUSED_CODE_RETRIEVAL (config default ON, #752)", async () => {
    // No env stubbed ⇒ the config default (now true) governs. The searcher IS
    // queried and provenance-carrying chunks are returned.
    __resetConfigSingleton();
    const searcher = makeSearcher([rawHit()]);
    const chunks = await retrieveFusedCodeChunks({
      projectId: "proj-1",
      query: "auth login",
      ragChunks: [],
      deps: { searcher, lineLookup: makeLineLookup(spans) },
    });
    expect(searcher.search).toHaveBeenCalledWith("auth login", "proj-1", { limit: 12 });
    expect(chunks).toHaveLength(1);
  });

  it("reads enabled + budgets from config when env sets them", async () => {
    vi.stubEnv("ANALYSIS_FUSED_CODE_RETRIEVAL", "true");
    __resetConfigSingleton();
    const searcher = makeSearcher([rawHit()]);
    const chunks = await retrieveFusedCodeChunks({
      projectId: "proj-1",
      query: "auth login",
      ragChunks: [],
      deps: { searcher, lineLookup: makeLineLookup(spans) },
    });
    expect(searcher.search).toHaveBeenCalledWith("auth login", "proj-1", { limit: 12 });
    expect(chunks).toHaveLength(1);
  });
});

describe("retrieveFusedCodeChunks — flag on (AC: fused hits + provenance)", () => {
  it("returns provenance-carrying chunks for resolved symbol hits", async () => {
    const searcher = makeSearcher([
      rawHit(),
      rawHit({ symbolId: "sym-2", filePath: "src/lib/auth/session.ts", name: "Session" }),
    ]);
    const chunks = await retrieveFusedCodeChunks({
      projectId: "proj-1",
      query: "auth login",
      ragChunks: [],
      enabled: true,
      tokenBudget: 1500,
      maxSymbols: 12,
      deps: { searcher, lineLookup: makeLineLookup(spans) },
    });
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({
      documentId: `${CODE_GRAPH_DOCUMENT_PREFIX}sym-1`,
      source: "code-graph",
      filePath: "src/lib/auth/login.ts",
      startLine: 12,
      endLine: 48,
    });
    expect(chunks[0]!.text).toContain("src/lib/auth/login.ts:12-48");
    // Unique documentId keys so the orchestrator's `${documentId}:${chunkIndex}`
    // merge dedupe never collapses two distinct symbols.
    expect(new Set(chunks.map((c) => `${c.documentId}:${c.chunkIndex}`)).size).toBe(2);
  });

  it("drops hits already covered by a source-as-RAG chunk (dedupe)", async () => {
    const searcher = makeSearcher([
      rawHit(), // covered by the RAG chunk below → dropped
      rawHit({ symbolId: "sym-2", filePath: "src/lib/auth/session.ts", name: "Session" }),
    ]);
    const chunks = await retrieveFusedCodeChunks({
      projectId: "proj-1",
      query: "auth login",
      ragChunks: [{ filename: "connector:repo:conn1:src/src/lib/auth/login.ts" }],
      enabled: true,
      tokenBudget: 1500,
      maxSymbols: 12,
      deps: { searcher, lineLookup: makeLineLookup(spans) },
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.symbolId).toBe("sym-2");
  });

  it("truncates the ranked tail deterministically under the token budget", async () => {
    const many = Array.from({ length: 6 }, (_, i) =>
      rawHit({ symbolId: `sym-b${i}`, name: `Symbol${i}`, filePath: `src/f${i}.ts` }),
    );
    const bSpans = Object.fromEntries(
      many.map((h) => [h.symbolId, { filePath: h.filePath, startLine: 1, endLine: 50 }]),
    );
    const run = () =>
      retrieveFusedCodeChunks({
        projectId: "proj-1",
        query: "auth login",
        ragChunks: [],
        enabled: true,
        // Small budget: the header (~99 tok) + first entries fit, the tail must not.
        tokenBudget: 150,
        maxSymbols: 12,
        deps: { searcher: makeSearcher(many), lineLookup: makeLineLookup(bSpans) },
      });
    const first = await run();
    const second = await run();
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThan(many.length);
    // Deterministic: same input ⇒ same truncation.
    expect(second).toEqual(first);
    // Rank order preserved — the survivors are the head of the ranked list.
    expect(first.map((c) => c.symbolId)).toEqual(
      many.slice(0, first.length).map((h) => h.symbolId),
    );
  });

  it("skips hits whose line span cannot be resolved (no locator)", async () => {
    const searcher = makeSearcher([rawHit({ symbolId: "sym-unknown" })]);
    const chunks = await retrieveFusedCodeChunks({
      projectId: "proj-1",
      query: "auth login",
      ragChunks: [],
      enabled: true,
      tokenBudget: 1500,
      maxSymbols: 12,
      deps: { searcher, lineLookup: makeLineLookup(spans) },
    });
    expect(chunks).toEqual([]);
  });

  it("degrades to [] when the searcher throws (no code graph, store error)", async () => {
    const searcher: FusedCodeSearcher = {
      search: async () => {
        throw new Error("boom");
      },
    };
    const chunks = await retrieveFusedCodeChunks({
      projectId: "proj-1",
      query: "auth login",
      ragChunks: [],
      enabled: true,
      tokenBudget: 1500,
      maxSymbols: 12,
      deps: { searcher, lineLookup: makeLineLookup(spans) },
    });
    expect(chunks).toEqual([]);
  });

  it("returns [] for an empty query without querying the searcher", async () => {
    const searcher = makeSearcher([rawHit()]);
    const chunks = await retrieveFusedCodeChunks({
      projectId: "proj-1",
      query: "   ",
      ragChunks: [],
      enabled: true,
      tokenBudget: 1500,
      maxSymbols: 12,
      deps: { searcher, lineLookup: makeLineLookup(spans) },
    });
    expect(chunks).toEqual([]);
    expect(searcher.search).not.toHaveBeenCalled();
  });
});

describe("buildCodeAgentFusedQuery (#729)", () => {
  it("composes project metadata with requirement texts", () => {
    expect(
      buildCodeAgentFusedQuery({
        projectName: "Acme",
        projectDescription: "billing monolith",
        requirementTexts: ["users can log in", "audit trail retained"],
      }),
    ).toBe("Acme. billing monolith. users can log in. audit trail retained");
  });

  it("includes operator notes and skips blank requirement texts", () => {
    expect(
      buildCodeAgentFusedQuery({
        projectName: "Acme",
        extraInstructions: "add SSO",
        requirementTexts: ["  ", "SAML support"],
      }),
    ).toBe("Acme. add SSO. SAML support");
  });

  it("falls back to the static code bag when everything is empty", () => {
    expect(buildCodeAgentFusedQuery({ requirementTexts: [] })).toBe(RETRIEVAL_QUERIES.code);
  });
});

describe("renderFusedCodeContextBlock + estimateFusedBlockTokens (#729)", () => {
  it("renders a numbered, headered reference block", () => {
    const block = renderFusedCodeContextBlock([
      symbolHitToContextChunk({
        symbolId: "s1",
        filePath: "src/a.ts",
        startLine: 3,
        endLine: 9,
        name: "Foo",
        kind: "class",
        score: 1,
        snippet: "class Foo {}",
      }),
    ]);
    expect(block).toContain("UNTRUSTED reference");
    expect(block).toContain("[1] Foo (class) — src/a.ts:3-9");
  });

  it("returns an empty string (0 tokens) for no chunks", () => {
    const block = renderFusedCodeContextBlock([]);
    expect(block).toBe("");
    expect(estimateFusedBlockTokens(block)).toBe(0);
  });

  it("estimates ~1 token per 4 chars", () => {
    expect(estimateFusedBlockTokens("12345678")).toBe(2);
  });
});

describe("retrieveFusedCodeContext (#729) — shared agentic/req-grounded helper", () => {
  it("flag off (ANALYSIS_FUSED_CODE_RETRIEVAL=false): empty chunks + block + zero tokens, searcher untouched", async () => {
    vi.stubEnv("ANALYSIS_FUSED_CODE_RETRIEVAL", "false");
    __resetConfigSingleton();
    const searcher = makeSearcher([rawHit()]);
    const ctx = await retrieveFusedCodeContext({
      projectId: "proj-1",
      projectName: "Acme",
      requirements: [{ id: "REQ-001", text: "users can log in" }],
      ragChunks: [],
      deps: { searcher, lineLookup: makeLineLookup(spans) },
    });
    expect(ctx).toEqual({ chunks: [], block: "", tokens: 0 });
    expect(searcher.search).not.toHaveBeenCalled();
  });

  it("flag DEFAULT (no env, #752): queries the searcher and returns a rendered block", async () => {
    __resetConfigSingleton();
    const searcher = makeSearcher([rawHit()]);
    const ctx = await retrieveFusedCodeContext({
      projectId: "proj-1",
      projectName: "Acme",
      projectDescription: "billing monolith",
      requirements: [{ id: "REQ-001", text: "users can log in" }],
      ragChunks: [],
      deps: { searcher, lineLookup: makeLineLookup(spans) },
    });
    expect(searcher.search).toHaveBeenCalled();
    expect(ctx.chunks).toHaveLength(1);
    expect(ctx.block).toContain("src/lib/auth/login.ts:12-48");
    expect(ctx.tokens).toBeGreaterThan(0);
  });

  it("flag on: returns provenance chunks, a rendered block, and its token cost", async () => {
    const searcher = makeSearcher([rawHit()]);
    const ctx = await retrieveFusedCodeContext({
      projectId: "proj-1",
      projectName: "Acme",
      projectDescription: "billing monolith",
      requirements: [{ id: "REQ-001", text: "users can log in" }],
      ragChunks: [],
      enabled: true,
      deps: { searcher, lineLookup: makeLineLookup(spans) },
    });
    // Query fused project metadata + requirement text.
    expect(searcher.search).toHaveBeenCalledWith(
      "Acme. billing monolith. users can log in",
      "proj-1",
      { limit: 12 },
    );
    expect(ctx.chunks).toHaveLength(1);
    expect(ctx.chunks[0]!.source).toBe("code-graph");
    expect(ctx.block).toContain("src/lib/auth/login.ts:12-48");
    expect(ctx.tokens).toBe(estimateFusedBlockTokens(ctx.block));
    expect(ctx.tokens).toBeGreaterThan(0);
  });
});
