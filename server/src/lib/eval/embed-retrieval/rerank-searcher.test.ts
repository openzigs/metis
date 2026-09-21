/**
 * Epic #1156 / Issue #1158 — the eval-only rerank decorator.
 *
 * Two things are load-bearing here and both were acceptance criteria on #1158:
 *
 *   1. **The passage text is `formatSymbolForEmbedding` output and nothing else.** A
 *      rerank passage that differs from the embedded text reintroduces the train/serve
 *      skew `project-code-searcher.ts` warns about, so the assertion compares against
 *      the formatter's own output rather than against a hand-written string.
 *   2. **A missing or corrupt model degrades to the fused ordering and never throws.**
 *      `reranker.ts` promises it; this decorator has to INHERIT it, and the last test
 *      here proves it through the real `XenovaCrossEncoderReranker` with an
 *      unloadable model rather than through a convenient stub.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildPassageTexts, createRerankingSearcher } from "./rerank-searcher.js";
import { formatSymbolForEmbedding, type SymbolKind } from "../../code-graph/symbol-embeddings.js";
import type { FusedCodeSearcher, RawCodeSymbolHit } from "../../rag/fused-code-context.js";
import type { RerankCandidate, Reranker } from "../../rag/reranker.js";
import type { EmbedRetrievalCorpus } from "./corpus.js";

// ---- Fixtures -------------------------------------------------------------

const HITS: RawCodeSymbolHit[] = Array.from({ length: 40 }, (_, i) => ({
  symbolId: `sym-${i}`,
  filePath: `src/server${i}.ts`,
  name: `handle${i}`,
  kind: "function",
  score: 1 - i / 100,
}));

/** Records the limit it was asked for, so the pool widening is observable. */
class RecordingBase implements FusedCodeSearcher {
  limits: number[] = [];
  async search(_q: string, _p: string, opts?: { limit?: number }): Promise<RawCodeSymbolHit[]> {
    const limit = opts?.limit ?? 20;
    this.limits.push(limit);
    return HITS.slice(0, limit);
  }
}

class RecordingReranker implements Reranker {
  readonly enabled = true;
  seen: RerankCandidate[][] = [];
  async rerank(_q: string, candidates: RerankCandidate[]): Promise<RerankCandidate[]> {
    this.seen.push(candidates.map((c) => ({ ...c })));
    return [...candidates].reverse().map((c, i) => ({ ...c, score: candidates.length - i }));
  }
}

const PASSAGES = new Map(HITS.map((h) => [h.symbolId, `PASSAGE ${h.symbolId}`]));
const PROJECT = "proj-1";
const QUERY = "handle an incoming request";

// ---- Pool widening --------------------------------------------------------

describe("createRerankingSearcher — widen, rerank, trim (#1158)", () => {
  it("asks the base searcher for the POOL and returns only the limit", async () => {
    const base = new RecordingBase();
    const reranker = new RecordingReranker();
    const searcher = createRerankingSearcher(base, reranker, { poolSize: 30, passages: PASSAGES });

    const out = await searcher.search(QUERY, PROJECT, { limit: 10 });

    expect(base.limits).toEqual([30]);
    expect(reranker.seen[0]).toHaveLength(30);
    expect(out).toHaveLength(10);
    // The stub reverses, so the pool's LAST candidate leads — a symbol fusion put
    // outside the top-10, which is the entire reason for widening.
    expect(out[0].symbolId).toBe("sym-29");
  });

  it("never asks for a pool shallower than the requested limit", async () => {
    const base = new RecordingBase();
    const searcher = createRerankingSearcher(base, new RecordingReranker(), {
      poolSize: 5,
      passages: PASSAGES,
    });
    const out = await searcher.search(QUERY, PROJECT, { limit: 20 });
    expect(base.limits).toEqual([20]);
    expect(out).toHaveLength(20);
  });

  it("carries the reranker's score onto the returned hits", async () => {
    const searcher = createRerankingSearcher(new RecordingBase(), new RecordingReranker(), {
      poolSize: 12,
      passages: PASSAGES,
    });
    const out = await searcher.search(QUERY, PROJECT, { limit: 3 });
    expect(out.map((h) => h.score)).toEqual([12, 11, 10]);
  });

  it("returns an empty pool untouched", async () => {
    const empty: FusedCodeSearcher = {
      async search() {
        return [];
      },
    };
    const reranker = new RecordingReranker();
    const searcher = createRerankingSearcher(empty, reranker, { poolSize: 30, passages: PASSAGES });
    expect(await searcher.search(QUERY, PROJECT, { limit: 10 })).toEqual([]);
    expect(reranker.seen).toHaveLength(0);
  });

  it("passes the caller's other search options through unchanged", async () => {
    const seen: unknown[] = [];
    const base: FusedCodeSearcher = {
      async search(_q, _p, opts) {
        seen.push(opts);
        return HITS.slice(0, 5);
      },
    };
    const searcher = createRerankingSearcher(base, new RecordingReranker(), {
      poolSize: 30,
      passages: PASSAGES,
    });
    await searcher.search(QUERY, PROJECT, { limit: 10, fileGlob: "src/**" } as never);
    expect(seen[0]).toMatchObject({ fileGlob: "src/**", limit: 30 });
  });
});

// ---- Passage text ---------------------------------------------------------

describe("buildPassageTexts — one formatter, not two (#1158)", () => {
  const corpus = {
    symbols: [
      {
        id: "s1",
        name: "assertWithinBudget",
        qualifiedName: "finops.assertWithinBudget",
        kind: "function",
        filePath: "finops/budget-enforcer.ts",
      },
      {
        id: "t1",
        name: "workspace_members",
        qualifiedName: "workspace_members",
        kind: "table",
        filePath: "schema/schema.prisma",
      },
    ],
    docs: [
      {
        id: "s1",
        filePath: "finops/budget-enforcer.ts",
        name: "assertWithinBudget",
        kind: "function",
        text: "PERSISTED INDEX-TIME TEXT",
      },
    ],
  } as unknown as EmbedRetrievalCorpus;

  it("replays the persisted index-time text verbatim when the corpus has one", () => {
    expect(buildPassageTexts(corpus).get("s1")).toBe("PERSISTED INDEX-TIME TEXT");
  });

  it("formats a symbol with no embedding through the SAME formatter", () => {
    // SQL symbols never get a `CodeSymbolEmbedding` row in production, so there is no
    // persisted text to replay for them — they must still go through the one formatter.
    expect(buildPassageTexts(corpus).get("t1")).toBe(
      formatSymbolForEmbedding({
        symbolId: "t1",
        name: "workspace_members",
        qualifiedName: "workspace_members",
        kind: "table" as SymbolKind,
        filePath: "schema/schema.prisma",
      }),
    );
    expect(buildPassageTexts(corpus).get("t1")).toBe(
      "table workspace_members in schema/schema.prisma",
    );
  });

  it("hands the reranker exactly those passages", async () => {
    const reranker = new RecordingReranker();
    const searcher = createRerankingSearcher(new RecordingBase(), reranker, {
      poolSize: 4,
      passages: PASSAGES,
    });
    await searcher.search(QUERY, PROJECT, { limit: 2 });
    expect(reranker.seen[0].map((c) => c.text)).toEqual([
      "PASSAGE sym-0",
      "PASSAGE sym-1",
      "PASSAGE sym-2",
      "PASSAGE sym-3",
    ]);
  });

  it("falls back to the header line for a symbol the passage map does not know", async () => {
    const reranker = new RecordingReranker();
    const searcher = createRerankingSearcher(new RecordingBase(), reranker, {
      poolSize: 2,
      passages: new Map(),
    });
    await searcher.search(QUERY, PROJECT, { limit: 2 });
    expect(reranker.seen[0][0].text).toBe("function handle0 in src/server0.ts");
  });
});

// ---- Degradation ----------------------------------------------------------

describe("degradation — the decorator inherits reranker.ts's promise (#1158)", () => {
  const fused = HITS.slice(0, 10).map((h) => h.symbolId);

  async function rankWith(reranker: Reranker): Promise<string[]> {
    const searcher = createRerankingSearcher(new RecordingBase(), reranker, {
      poolSize: 30,
      passages: PASSAGES,
    });
    return (await searcher.search(QUERY, PROJECT, { limit: 10 })).map((h) => h.symbolId);
  }

  it("returns the fused ordering when the reranker REJECTS, without throwing", async () => {
    expect(
      await rankWith({
        enabled: true,
        async rerank() {
          throw new Error("model file is corrupt");
        },
      }),
    ).toEqual(fused);
  });

  it("returns the fused ordering when the reranker returns an empty list", async () => {
    expect(
      await rankWith({
        enabled: true,
        async rerank() {
          return [];
        },
      }),
    ).toEqual(fused);
  });

  it("returns the fused ordering when the reranker is a no-op passthrough", async () => {
    expect(
      await rankWith({
        enabled: false,
        async rerank(_q, c) {
          return c;
        },
      }),
    ).toEqual(fused);
  });

  it("does not shorten the list when the reranker DROPS candidates", async () => {
    const out = await rankWith({
      enabled: true,
      async rerank(_q, c) {
        return c.slice(0, 2).map((x) => ({ ...x, score: 99 }));
      },
    });
    expect(out).toHaveLength(10);
    expect(out.slice(0, 2)).toEqual(fused.slice(0, 2));
  });

  it("drops ids the reranker invented", async () => {
    const out = await rankWith({
      enabled: true,
      async rerank(_q, c) {
        return [{ chunkId: "not-a-symbol", text: "", score: 100 }, ...c];
      },
    });
    expect(out).not.toContain("not-a-symbol");
    expect(out).toHaveLength(10);
  });

  it("ignores a duplicate id the reranker returned twice", async () => {
    const out = await rankWith({
      enabled: true,
      async rerank(_q, c) {
        return [c[3], c[3], ...c];
      },
    });
    expect(new Set(out).size).toBe(out.length);
    expect(out[0]).toBe("sym-3");
  });
});

// ---- A genuinely unloadable MODEL, through the real cross-encoder ----------

describe("degradation with the REAL cross-encoder and a broken model (#1158)", () => {
  const ORIGINAL_MODE = process.env.EMBEDDINGS_MODE;

  beforeEach(() => {
    vi.resetModules();
    process.env.EMBEDDINGS_MODE = "in-process";
  });

  afterEach(() => {
    vi.doUnmock("@huggingface/transformers");
    vi.resetModules();
    if (ORIGINAL_MODE == null) delete process.env.EMBEDDINGS_MODE;
    else process.env.EMBEDDINGS_MODE = ORIGINAL_MODE;
  });

  it("degrades to the fused ordering when the ONNX weights cannot be loaded", async () => {
    vi.doMock("@huggingface/transformers", () => ({
      AutoTokenizer: { from_pretrained: async () => () => ({}) },
      AutoModelForSequenceClassification: {
        from_pretrained: async () => {
          throw new Error("ENOENT: model_quantized.onnx");
        },
      },
      env: { allowRemoteModels: undefined },
    }));

    const { createCrossEncoderReranker } = await import("../../rag/reranker.js");
    const { createRerankingSearcher: make } = await import("./rerank-searcher.js");

    const reranker = createCrossEncoderReranker();
    expect(reranker.enabled).toBe(true);

    const searcher = make(new RecordingBase(), reranker, { poolSize: 30, passages: PASSAGES });
    const out = await searcher.search(QUERY, PROJECT, { limit: 10 });

    expect(out.map((h) => h.symbolId)).toEqual(HITS.slice(0, 10).map((h) => h.symbolId));
  });
});
