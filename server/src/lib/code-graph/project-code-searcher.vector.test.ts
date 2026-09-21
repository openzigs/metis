/**
 * Epic #780 / Issue #797 — the acceptance suite for the wired symbol-embedding
 * store. This is the test the issue is actually about.
 *
 * ## The claim under test
 *
 * `search_code_symbols` used to be BM25-only, and production BM25 indexes ONLY
 * `name` + `qualifiedName` (`CodeSymbol` persists no signature or docstring). So
 * a natural-language requirement that shares no tokens with the symbol's NAME was
 * unfindable — which is exactly the NL-requirement → code case the whole feature
 * exists to serve.
 *
 * The fixture is real, not invented: `assertWithinBudget` from the committed #788
 * eval snapshot (`eval-data/corpus/embedretrieval-01-nl-to-code/repo/finops/
 * budget-enforcer.ts`), with every other symbol in the snapshot acting as a
 * distractor — including the two natural in-file confusables, `BudgetExceededError`
 * and `projectMonthlyCost`.
 *
 * ## Two embedders, two different claims — read this before trusting a green run
 *
 *   - The DEFAULT run uses a deterministic concept-lexicon stand-in. It proves
 *     the WIRING: that a vector hit with ZERO BM25 support is embedded, stored,
 *     retrieved, and reaches the fused ranking through the real `HybridCodeSearch`,
 *     the real Prisma symbol index and a real `VectorStore`. It does NOT prove
 *     the model's semantics — a stand-in embedder cannot.
 *   - The GATED run (`EMBEDDINGS_MODEL_DOWNLOAD_TESTS=1`) uses the REAL production
 *     embedder (`getEmbedder()` → gte-modernbert). That is the run that proves the
 *     semantic claim, and it is the one whose output belongs in the PR.
 *
 * Anything asserted here about ranking quality on the stand-in is a statement
 * about plumbing, not about retrieval.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalVectorStore } from "../rag/vector-store.js";
import { __resetReindexLeaseBackend } from "../rag/reindex-lease.js";
import type { EmbeddingResult } from "../rag/embedder.js";
import {
  corpusDir,
  LEGACY_CORPUS_ID,
  loadEmbedRetrievalCorpus,
  type EmbedRetrievalCorpus,
} from "../eval/embed-retrieval/corpus.js";
import { DEFAULT_EMBED_DIMENSION } from "@metis/shared";
import {
  DEFAULT_SIDECAR_EMBED_MODEL,
  resolveDtype,
  resolvePooling,
  type EmbedDtype,
  type EmbedPooling,
} from "../rag/embed-model-config.js";
import { DEFAULT_LIMIT } from "../analysis/tools/search-symbols.js";
import { DEFAULT_WEIGHTS, HybridCodeSearch, type SymbolVectorStore } from "./hybrid-search.js";
import { createDefaultCodeSearcher, prismaSymbolIndex } from "./project-code-searcher.js";
import { computeSymbolHash, type EmbedService } from "./symbol-embeddings.js";
import {
  createSymbolVectorStore,
  embedProjectSymbols,
  reindexProjectSymbols,
  symbolVectorsId,
} from "./symbol-embedding-service.js";

// ---- In-memory Prisma (CodeSymbol + CodeSymbolEmbedding) ------------------

interface SymbolRow {
  id: string;
  projectId: string;
  codeGraphId: string;
  name: string;
  qualifiedName: string;
  kind: string;
  filePath: string;
}
interface EmbeddingRow {
  symbolId: string;
  projectId: string;
  codeGraphId: string;
  text: string;
  contentHash: string;
  embeddingModel: string;
}

let symbolRows: SymbolRow[] = [];
let embeddingRows: EmbeddingRow[] = [];

const matchWhere = (row: Record<string, unknown>, where: Record<string, unknown> = {}): boolean => {
  for (const [k, v] of Object.entries(where)) {
    if (v && typeof v === "object" && "in" in (v as Record<string, unknown>)) {
      if (!(v as { in: unknown[] }).in.includes(row[k])) return false;
    } else if (v && typeof v === "object" && "not" in (v as Record<string, unknown>)) {
      if (row[k] === (v as { not: unknown }).not) return false;
    } else if (row[k] !== v) {
      return false;
    }
  }
  return true;
};

vi.mock("../prisma.js", () => ({
  prisma: {
    codeSymbol: {
      findMany: vi.fn(
        async ({ where, take }: { where: Record<string, unknown>; take?: number }) => {
          const rows = symbolRows
            .filter((r) => matchWhere(r as unknown as Record<string, unknown>, where))
            .sort((a, b) => (a.id < b.id ? -1 : 1));
          return take ? rows.slice(0, take) : rows;
        },
      ),
    },
    codeSymbolEmbedding: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        embeddingRows
          .filter((r) => matchWhere(r as unknown as Record<string, unknown>, where))
          .sort((a, b) => (a.symbolId < b.symbolId ? -1 : 1))
          .map((r) => ({
            ...r,
            // Prisma relation include — the service selects `symbol: { select: … }`.
            symbol: symbolRows.find((s) => s.id === r.symbolId),
          })),
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Partial<EmbeddingRow>;
        }) => {
          let count = 0;
          for (const r of embeddingRows) {
            if (matchWhere(r as unknown as Record<string, unknown>, where)) {
              Object.assign(r, data);
              count += 1;
            }
          }
          return { count };
        },
      ),
      groupBy: vi.fn(async ({ where }: { where?: Record<string, unknown> }) => {
        const counts = new Map<string, number>();
        for (const r of embeddingRows) {
          if (!matchWhere(r as unknown as Record<string, unknown>, where ?? {})) continue;
          counts.set(r.embeddingModel, (counts.get(r.embeddingModel) ?? 0) + 1);
        }
        return [...counts.entries()].map(([embeddingModel, n]) => ({
          embeddingModel,
          _count: { _all: n },
        }));
      }),
    },
  },
}));

// ---- The stand-in embedder ------------------------------------------------

/**
 * A deterministic CONCEPT-LEXICON embedder: each dimension is one concept, and a
 * text's weight on it is how many of that concept's surface forms appear in the
 * text (camelCase-split, lowercased).
 *
 * It exists for one reason: to give the vector channel a signal that DOES NOT
 * come from the tokens BM25 sees, so a green CI run genuinely exercises the
 * "vector found what BM25 could not" path end-to-end. It is not a model, it makes
 * no claim about retrieval quality, and it is deliberately built from concepts an
 * analyst would use (spend/refuse/ai/…), not from the target's identifier.
 */
const CONCEPTS: Record<string, string[]> = {
  spend: [
    "budget",
    "allowance",
    "quota",
    "cap",
    "cost",
    "cents",
    "spend",
    "spent",
    "burned",
    "token",
    "tokens",
    "monthly",
    "month",
    "mtd",
    "usage",
  ],
  refuse: ["refuse", "block", "throw", "reject", "assert", "deny", "exceeded", "error", "status"],
  ai: ["ai", "llm", "model", "copilot", "provider", "prompt"],
  project: ["project", "workspace"],
  auth: ["auth", "token", "session", "login", "password", "permission", "role"],
  retrieval: ["search", "vector", "embed", "embedding", "chunk", "rank", "query"],
  storage: ["prisma", "table", "database", "store", "persist", "row"],
  http: ["route", "request", "response", "handler", "express", "endpoint"],
};
const CONCEPT_KEYS = Object.keys(CONCEPTS).sort();
const LEXICON = new Map<string, number[]>();
for (const [ci, key] of CONCEPT_KEYS.entries()) {
  for (const word of CONCEPTS[key]) {
    const vec = LEXICON.get(word) ?? new Array<number>(CONCEPT_KEYS.length).fill(0);
    vec[ci] = 1;
    LEXICON.set(word, vec);
  }
}

function tokenize(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

const STANDIN_MODEL = "test-concept-lexicon-v1";

const standInEmbedder: EmbedService & { model: string; dimension: number } = {
  model: STANDIN_MODEL,
  dimension: CONCEPT_KEYS.length,
  async embed(texts: string[]): Promise<EmbeddingResult> {
    const vectors = texts.map((t) => {
      const v = new Array<number>(CONCEPT_KEYS.length).fill(0);
      for (const tok of tokenize(t)) {
        const hit = LEXICON.get(tok);
        if (!hit) continue;
        for (let i = 0; i < v.length; i += 1) v[i] += hit[i];
      }
      // A text matching no concept must still be a legal vector, not a zero one
      // the cosine would divide by. Park it on an inert axis.
      if (v.every((x) => x === 0)) v[CONCEPT_KEYS.indexOf("http")] = 0.001;
      return v;
    });
    return { vectors, model: STANDIN_MODEL, dimension: CONCEPT_KEYS.length };
  },
};

// ---- Fixture --------------------------------------------------------------

const PROJECT = "proj-797";
const GRAPH = "graph-797";
const TARGET_NAME = "assertWithinBudget";
const TARGET_FILE = "finops/budget-enforcer.ts";

/**
 * The acceptance query. It shares NONE of `assert` / `within` / `budget` — the
 * only tokens production BM25 indexes for this symbol — and is phrased the way an
 * analyst writes a requirement, not the way a developer greps.
 */
const NL_QUERY =
  "The system must refuse to start a new AI call once a project has burned " +
  "through its allowance for the month";

let corpus: EmbedRetrievalCorpus;
let targetId: string;
let root: string;
let store: LocalVectorStore;

function seedPrisma(): void {
  symbolRows = corpus.symbols.map((s) => ({
    id: s.id,
    projectId: PROJECT,
    codeGraphId: GRAPH,
    name: s.name,
    qualifiedName: s.qualifiedName,
    kind: s.kind,
    filePath: s.filePath,
  }));
  embeddingRows = corpus.docs.map((d) => ({
    symbolId: d.id,
    projectId: PROJECT,
    codeGraphId: GRAPH,
    text: d.text,
    contentHash: computeSymbolHash(d.text),
    // "" = PENDING, exactly as `ingestCodeGraph` writes it.
    embeddingModel: "",
  }));
}

beforeAll(async () => {
  // PINNED to `embedretrieval-01` (#1157), and it must stay pinned.
  //
  // Every rank in this file is a CALIBRATED MEASUREMENT on a 183-symbol pool: the
  // top-20 containment bound below, the `search(..., 183)` depth in the gated block,
  // the `<= 15` rank bounds, and the "rank 12 of 183" / "rank 14 of 183" figures the
  // comments quote as evidence. #1157 moved `loadEmbedRetrievalCorpus()`'s DEFAULT to
  // the 793-symbol `embedretrieval-02`, and a bare no-arg call here would have
  // silently re-pointed all of that at a different distractor pool — the assertions
  // would still have executed, and would have been measuring something other than what
  // they document. Keeping the old corpus addressable by id is exactly why #1157
  // added a new corpus rather than mutating this one.
  //
  // If this file is ever re-baselined onto `embedretrieval-02`, every number above
  // has to be re-measured, not re-pointed.
  corpus = await loadEmbedRetrievalCorpus(corpusDir(LEGACY_CORPUS_ID));
  if (corpus.docs.length !== 183) {
    throw new Error(
      `this file's rank bounds are calibrated on 183 symbols; the pinned corpus now ` +
        `has ${corpus.docs.length}. Re-measure the bounds rather than relaxing them.`,
    );
  }
  const target = corpus.symbols.find((s) => s.name === TARGET_NAME && s.filePath === TARGET_FILE);
  if (!target) throw new Error(`fixture symbol ${TARGET_NAME} missing from the eval snapshot`);
  targetId = target.id;
});

beforeEach(async () => {
  // #876 — Prisma is stubbed here, so the reindex lease this path takes must be the no-op
  // one. `resolveReindexLeaseBackend()` reads `DATABASE_URL` lazily, so an ambient Postgres
  // URL (a developer dogfooding on Postgres) would otherwise wire a real
  // `PostgresReindexLeaseBackend` to the mock and fail on `$executeRawUnsafe`.
  delete process.env.DATABASE_URL;
  __resetReindexLeaseBackend();
  seedPrisma();
  root = path.join(os.tmpdir(), `sym797-${Math.random().toString(36).slice(2)}`);
  store = new LocalVectorStore({ root });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

afterAll(() => {
  vi.restoreAllMocks();
});

function deps(embedService: EmbedService & { model: string }) {
  return { store, embedService, model: (): string => embedService.model };
}

function hybridWith(
  vectorStore: SymbolVectorStore,
  embedService: EmbedService & { model: string },
): HybridCodeSearch {
  // The production Prisma symbol index — the same windowed lexical channel the
  // server uses, not a hand-built one.
  return new HybridCodeSearch(vectorStore, prismaSymbolIndex, embedService);
}

const emptyVectorStore: SymbolVectorStore = {
  async search() {
    return [];
  },
};

// ---- 1. THE ACCEPTANCE TEST ----------------------------------------------

describe("#797 — the vector channel finds what BM25 structurally cannot", () => {
  it("production BM25 alone cannot retrieve assertWithinBudget at ANY depth", async () => {
    const bm25Only = hybridWith(emptyVectorStore, standInEmbedder);
    // `limit` exceeds the whole corpus (183 symbols): this is not "it ranked
    // poorly", it is "it is not in the result set at all, at any cut-off". BM25
    // indexes name + qualifiedName only, and the requirement contains none of
    // `assert`, `within`, `budget`. No re-ranking of a lexical channel can
    // surface this symbol, ever.
    const hits = await bm25Only.search(NL_QUERY, PROJECT, {
      limit: 500,
      weights: { bm25Weight: 1, vectorWeight: 0 },
    });

    expect(hits.length).toBeGreaterThan(0); // BM25 did rank things — just not this
    expect(hits.map((h) => h.symbolId)).not.toContain(targetId);
    expect(hits.some((h) => h.name === TARGET_NAME)).toBe(false);
  });

  it("with symbol embeddings wired, the vector channel retrieves it — and it reaches the fused ranking", async () => {
    await embedProjectSymbols(PROJECT, deps(standInEmbedder));

    // (a) The store is real, populated and model-filtered, and the symbol is
    //     addressable BY MEANING: it is in the top 20 of 183 on cosine alone,
    //     from a query sharing none of its indexed tokens.
    const vectorStore = createSymbolVectorStore(deps(standInEmbedder));
    const { vectors } = await standInEmbedder.embed([NL_QUERY]);
    const vectorHits = await vectorStore.search(PROJECT, vectors[0], 20);
    expect(vectorHits.map((h) => h.metadata.symbolId)).toContain(targetId);

    // (b) And it reaches the FUSED ranking, which it previously could not do at
    //     any cut-off.
    const hybrid = hybridWith(vectorStore, standInEmbedder);
    const hits = await hybrid.search(NL_QUERY, PROJECT, { limit: 500, weights: DEFAULT_WEIGHTS });
    expect(hits.map((h) => h.symbolId)).toContain(targetId);

    // Deliberately NOT a top-3 assertion. The stand-in ranks the target ~12th on
    // cosine (behind `projectMonthlyCost` and `BudgetExceededError`, which a crude
    // concept lexicon cannot separate from it) and several of those distractors
    // ALSO draw BM25 support, so its fused rank is mid-list. Tightening the
    // lexicon until it hit top-3 would be tuning the oracle to the answer. The
    // top-3 claim is the REAL model's to make, and it makes it in the gated test
    // at the bottom of this file.
  });

  it("does not regress BM25: an exact-name query still ranks the symbol #1", async () => {
    await embedProjectSymbols(PROJECT, deps(standInEmbedder));

    const hybrid = hybridWith(createSymbolVectorStore(deps(standInEmbedder)), standInEmbedder);
    const hits = await hybrid.search(TARGET_NAME, PROJECT, { limit: 10 });

    expect(hits[0]?.symbolId).toBe(targetId);
  });
});

// ---- 2. The vectorWeight:0 guard must survive the real store ---------------

describe("#797 — vectorWeight: 0 genuinely skips the vector channel", () => {
  it("neither embeds the query nor touches the vector store", async () => {
    await embedProjectSymbols(PROJECT, deps(standInEmbedder));

    const vectorStore = createSymbolVectorStore(deps(standInEmbedder));
    const searchSpy = vi.spyOn(vectorStore, "search");
    const embedSpy = vi.fn(standInEmbedder.embed.bind(standInEmbedder));
    const spyEmbedder = { model: STANDIN_MODEL, embed: embedSpy };

    const hybrid = hybridWith(vectorStore, spyEmbedder);
    await hybrid.search(NL_QUERY, PROJECT, {
      limit: 10,
      weights: { bm25Weight: 1, vectorWeight: 0 },
    });

    // The #788 reference channel depends on this: a zero-weighted vector hit is
    // still INSERTED into the fused map at score 0, so it would pad the tail of a
    // "BM25-only" ranking in vector-rank order. Cutting the channel at the source
    // is the only way `vectorWeight: 0` means what it says — and that has to keep
    // holding now that the store is real and non-empty.
    expect(embedSpy).not.toHaveBeenCalled();
    expect(searchSpy).not.toHaveBeenCalled();
  });
});

// ---- 3. Model-tag isolation ----------------------------------------------

describe("#797 — model-tag isolation", () => {
  it("never returns a vector written by a different embedding model", async () => {
    await embedProjectSymbols(PROJECT, deps(standInEmbedder));

    // The active model is now something else — e.g. an operator flipped EMBED_MODEL
    // and has not reindexed yet. Every stored vector belongs to the old generation.
    const otherModel = { ...standInEmbedder, model: "some-other-model-v9" };
    const vectorStore = createSymbolVectorStore({
      store,
      embedService: otherModel,
      model: () => "some-other-model-v9",
    });

    const hits = await vectorStore.search(PROJECT, [1, 0, 0, 0, 0, 0, 0, 0], 20);

    // Ignored, not mis-scored. Two vector spaces are never compared.
    expect(hits).toEqual([]);
  });
});

// ---- 4. Idempotency / resume ---------------------------------------------

describe("#797 — the embed job is idempotent and resumable", () => {
  it("a second run embeds nothing and skips every symbol", async () => {
    const first = await embedProjectSymbols(PROJECT, deps(standInEmbedder));
    expect(first.embedded).toBe(corpus.docs.length);
    expect(first.skipped).toBe(0);

    const second = await embedProjectSymbols(PROJECT, deps(standInEmbedder));
    expect(second.embedded).toBe(0);
    expect(second.skipped).toBe(corpus.docs.length);
  });

  it("resumes from the last persisted batch after an interrupted run", async () => {
    let calls = 0;
    const dying: EmbedService & { model: string } = {
      model: STANDIN_MODEL,
      async embed(texts: string[]): Promise<EmbeddingResult> {
        calls += 1;
        // Die on the third sidecar post — i.e. after two batches are DURABLE.
        if (calls === 3) throw new Error("pod evicted mid-embed");
        return standInEmbedder.embed(texts);
      },
    };

    await expect(
      embedProjectSymbols(PROJECT, { store, embedService: dying, model: () => STANDIN_MODEL }),
    ).rejects.toThrow("pod evicted");

    const persisted = await store.count(symbolVectorsId(PROJECT));
    expect(persisted).toBeGreaterThan(0);
    expect(persisted).toBeLessThan(corpus.docs.length);

    // The restart re-embeds only what is left; the durable batches are skipped.
    const resumed = await embedProjectSymbols(PROJECT, deps(standInEmbedder));
    expect(resumed.skipped).toBe(persisted);
    expect(resumed.embedded).toBe(corpus.docs.length - persisted);
    expect(await store.count(symbolVectorsId(PROJECT))).toBe(corpus.docs.length);
  });

  it("prunes vectors whose symbol no longer exists (a deleted file's symbols)", async () => {
    await embedProjectSymbols(PROJECT, deps(standInEmbedder));
    expect(await store.count(symbolVectorsId(PROJECT))).toBe(corpus.docs.length);

    // Ingest re-parsed a file: its CodeSymbol rows were delete-then-recreated, so
    // the CodeSymbolEmbedding rows cascaded away. The VECTORS do not cascade —
    // they live in the vector store, and pruning them is this job's responsibility.
    const dropped = embeddingRows.filter((r) => r.symbolId !== targetId).slice(0, 5);
    const droppedIds = new Set(dropped.map((r) => r.symbolId));
    embeddingRows = embeddingRows.filter((r) => !droppedIds.has(r.symbolId));
    symbolRows = symbolRows.filter((r) => !droppedIds.has(r.id));

    const result = await embedProjectSymbols(PROJECT, deps(standInEmbedder));
    expect(result.deleted).toBe(5);
    expect(await store.count(symbolVectorsId(PROJECT))).toBe(corpus.docs.length - 5);
  });
});

// ---- 5. #787 reindex covers symbol vectors --------------------------------

describe("#797 — a model flip reindexes symbol vectors (#787 phase 2)", () => {
  it("re-embeds from the persisted text and atomically swaps the live namespace", async () => {
    await embedProjectSymbols(PROJECT, deps(standInEmbedder));
    expect(embeddingRows.every((r) => r.embeddingModel === STANDIN_MODEL)).toBe(true);

    // A NEW model, of a DIFFERENT width. No repo checkout is available — the
    // reindex must rebuild every vector from `CodeSymbolEmbedding.text` alone.
    const NEW_MODEL = "test-new-model-v2";
    const newEmbedder: EmbedService & { model: string } = {
      model: NEW_MODEL,
      async embed(texts: string[]): Promise<EmbeddingResult> {
        const base = await standInEmbedder.embed(texts);
        return {
          vectors: base.vectors.map((v) => [...v, 1]), // wider on purpose
          model: NEW_MODEL,
          dimension: base.dimension + 1,
        };
      },
    };

    const result = await reindexProjectSymbols(PROJECT, {
      store,
      embedService: newEmbedder,
      model: () => NEW_MODEL,
    });

    expect(result.totalSymbols).toBe(corpus.docs.length);
    expect(result.embeddedSymbols).toBe(corpus.docs.length);
    // Prisma tags reconciled AFTER the swap — the DB never claims a vector that
    // does not exist.
    expect(embeddingRows.every((r) => r.embeddingModel === NEW_MODEL)).toBe(true);

    const live = await store.search(symbolVectorsId(PROJECT), [1, 0, 0, 0, 0, 0, 0, 0, 0], 5, {
      embeddingModel: NEW_MODEL,
    });
    expect(live.length).toBeGreaterThan(0);
    expect(live[0].row.vector).toHaveLength(CONCEPT_KEYS.length + 1);
  });
});

// ---- 6. The 5000-symbol window must not eat vector hits -------------------

describe("#797 — a vector hit outside the BM25 window is not discarded", () => {
  it("hydrates a symbol the windowed lexical index never returned", async () => {
    await embedProjectSymbols(PROJECT, deps(standInEmbedder));

    // Simulate the production window: the lexical index (`take: MAX_INDEXED_SYMBOLS`,
    // ~15k symbols in METIS vs a 5000 cap) simply does not contain the target. Before
    // #797 the fused ranking filtered vector hits through THIS set, so a correct
    // vector hit outside the window was thrown away AFTER the embed + search had
    // already been paid for.
    const windowed = corpus.searchable.filter((s) => s.symbolId !== targetId);
    const windowedIndex: import("./hybrid-search.js").SymbolIndex = {
      async getSymbols() {
        return windowed;
      },
      async getSymbolsByIds(_projectId, ids) {
        return corpus.searchable.filter((s) => ids.includes(s.symbolId));
      },
    };

    const hybrid = new HybridCodeSearch(
      createSymbolVectorStore(deps(standInEmbedder)),
      windowedIndex,
      standInEmbedder,
    );
    const hits = await hybrid.search(NL_QUERY, PROJECT, { limit: 500, weights: DEFAULT_WEIGHTS });
    expect(hits.map((h) => h.symbolId)).toContain(targetId);
  });

  it("still honours fileGlob for a hydrated hit (hydration is not a filter bypass)", async () => {
    await embedProjectSymbols(PROJECT, deps(standInEmbedder));

    const windowed = corpus.searchable.filter((s) => s.symbolId !== targetId);
    const windowedIndex: import("./hybrid-search.js").SymbolIndex = {
      async getSymbols() {
        return windowed;
      },
      async getSymbolsByIds(_projectId, ids) {
        return corpus.searchable.filter((s) => ids.includes(s.symbolId));
      },
    };

    const hybrid = new HybridCodeSearch(
      createSymbolVectorStore(deps(standInEmbedder)),
      windowedIndex,
      standInEmbedder,
    );
    const hits = await hybrid.search(NL_QUERY, PROJECT, {
      limit: 10,
      weights: DEFAULT_WEIGHTS,
      fileGlob: "rag/**",
    });
    expect(hits.map((h) => h.symbolId)).not.toContain(targetId);
    expect(hits.every((h) => h.filePath.startsWith("rag/"))).toBe(true);
  });
});

// ---- 7. THE REAL MODEL (gated) -------------------------------------------

/**
 * The semantic claim, with the PRODUCTION embedder. Gated on the same env flag
 * #781/#788 use so CI's default job never pulls hundreds of MB of ONNX weights:
 *
 *   EMBEDDINGS_MODEL_DOWNLOAD_TESTS=1 pnpm --filter @metis/server exec \
 *     vitest run src/lib/code-graph/project-code-searcher.vector.test.ts
 */
const DOWNLOAD_ENABLED = process.env.EMBEDDINGS_MODEL_DOWNLOAD_TESTS === "1";

/**
 * The SHIPPED embedder config, DERIVED — never restated (PR #803 review, L1).
 *
 * Hardcoding `dimension: 768, pooling: "cls", dtype: "q8"` here would be a miniature
 * #792: if #783's shipped defaults move (a re-pooled model, an fp32 flip), production
 * changes while this test keeps asserting the OLD config — it would still pass, still
 * look like "the real production embedder", and silently no longer be one. Every field
 * comes from the same source `getEmbedder()` reads.
 *
 * (`getEmbedder()` itself is unusable here: the server test harness pins `AI_OFFLINE=1`
 * in `tests/setup.ts`, which resolves the singleton to the deterministic HASH stub — a
 * green run against that would prove nothing while looking real. So we build the
 * production `Embedder` from the production config instead.)
 */
function realEmbedderConfig(): {
  backend: "xenova";
  model: string;
  dimension: number;
  pooling: EmbedPooling;
  dtype: EmbedDtype;
} {
  return {
    backend: "xenova",
    model: DEFAULT_SIDECAR_EMBED_MODEL,
    dimension: DEFAULT_EMBED_DIMENSION,
    pooling: resolvePooling(DEFAULT_SIDECAR_EMBED_MODEL).pooling,
    dtype: resolveDtype(),
  };
}

describe.runIf(DOWNLOAD_ENABLED)("#797 — with the REAL production embedder", () => {
  /**
   * MEASURED RESULT (gte-modernbert-base · 768d · CLS · q8, 183-symbol corpus), after
   * #807's batch-invariance fix and the weight re-sweep it forced. These numbers are
   * what the run below actually produces — not a target:
   *
   *   query                     BM25-only       vector    hybrid (0.05/0.95)
   *   ------------------------- --------------- --------- ------------------
   *   keyword-free NL (below)   ABSENT (0/183)  rank 12   rank 14  ← inside DEFAULT_LIMIT
   *
   * ## What #807 changed, and why the old numbers in this comment were wrong
   *
   * #797 recorded a puzzle here: the sweep harness ranked the vector channel 18th and
   * this file's harness ranked it 14th, on the SAME corpus and model. It correctly
   * traced that to batching — the two harnesses feed the 183 texts in different orders,
   * so each symbol lands in a different batch — and correctly measured that at
   * `batchSize: 1` both harnesses agree bit-for-bit at rank 12.
   *
   * It attributed the effect to PADDING, and declined to fix it on the grounds that a
   * batch of 1 would mean "183 sidecar posts instead of 3 … an overnight job" at
   * METIS's ~15k symbols. #807 found BOTH of those to be wrong:
   *
   *   - The cause is NOT padding. A batch of 64 IDENTICAL texts (zero padding)
   *     reproduces the batch-1 vector EXACTLY; a batch of same-length, different-content
   *     texts (also zero padding) still drifts. It is the per-tensor activation scale
   *     that `q8`'s `DynamicQuantizeLinear` nodes derive from the WHOLE batch tensor —
   *     so batch COMPOSITION, padding or not, re-quantizes every row. (Length-sorting
   *     the batch, the obvious "reduce the padding" fix, would therefore have done
   *     nothing.)
   *   - The cost is NOT 64× the posts. The fix bounds the MODEL FORWARD, not the HTTP
   *     request: the sidecar still takes 64 texts per POST and simply runs them one at a
   *     time. Measured cost: 1.87× CPU on the embed job. Not an overnight job.
   *
   * See `resolveForwardBatch` in `embed-model-config.ts` for the full mechanism, and
   * `tests/rag-embedder-batch-invariance.test.ts` for the acceptance measurement
   * (cos(batch-1, batch-64): 0.974 before, 1.000 after).
   *
   * ## Three things are true, and the third is no longer the uncomfortable one
   *
   * 1. THE #797 DEFECT IS FIXED AT THE CHANNEL LEVEL. BM25 cannot retrieve
   *    `assertWithinBudget` for the keyword-free requirement at ANY cut-off — not rank
   *    500, not rank 183; it is not in the result set, because BM25 only ever saw
   *    `assert|within|budget|finops|enforcer` and the requirement contains none of
   *    them. With the vector half wired the symbol is retrievable at all.
   *
   * 2. THE VECTOR ITSELF WAS BEING DEGRADED BY INGEST, AND #807 FIXED THAT. The same
   *    symbol, same model, same text ranked 18th when embedded in a production-sized
   *    batch and 12th when embedded alone. It now ranks 12th always, because the vector
   *    no longer depends on what else shared its batch. Realised vector nDCG@10 on the
   *    30-requirement corpus: 0.385 → 0.461.
   *
   * 3. IT NOW REACHES THE AGENT. `search_code_symbols` returns the top DEFAULT_LIMIT
   *    (15) — a number #807 explicitly did NOT move. With the vector channel's own rank
   *    down to 12, the RRF floor (fusion cannot promote a symbol above its own best
   *    channel) is 12 rather than 18, and the re-swept weights land the fused rank at
   *    14. The symbol is in the agent's result set.
   *
   * This test asserts the measured truth and does not pretend otherwise.
   */
  it("retrieves assertWithinBudget for a query BM25 cannot answer at ANY depth", async () => {
    // NOT `getEmbedder()`: the server test harness pins `AI_OFFLINE=1`
    // (tests/setup.ts), which resolves the singleton to the deterministic HASH
    // stub — a green run against that would prove nothing while looking real.
    // Build the production `Embedder` with the ACTIVE default config instead
    // (#783: gte-modernbert-base · 768d · CLS · q8): the same object
    // `getEmbedder()` returns on a deployment that is not air-gapped, and the
    // same construction #788's eval scores.
    const { Embedder } = await import("../rag/embedder.js");
    const { AIR_GAP_EMBED_MODEL } = await import("../rag/embed-model-config.js");
    const embedder = new Embedder(realEmbedderConfig());
    const probe = await embedder.embed(["warm"]);
    // If this is not the real model, every assertion below is meaningless.
    expect(probe.dimension).toBe(realEmbedderConfig().dimension);
    expect(embedder.model).toBe(AIR_GAP_EMBED_MODEL);

    const realDeps = { store, embedService: embedder, model: (): string => embedder.model };
    await embedProjectSymbols(PROJECT, realDeps);

    // (1) BM25 cannot reach it. `limit` exceeds the whole corpus, so this is
    //     "not in the result set", not "ranked low".
    const bm25Only = hybridWith(emptyVectorStore, embedder);
    const bm25Hits = await bm25Only.search(NL_QUERY, PROJECT, {
      limit: 500,
      weights: { bm25Weight: 1, vectorWeight: 0 },
    });
    expect(bm25Hits.length).toBeGreaterThan(0);
    expect(bm25Hits.map((h) => h.symbolId)).not.toContain(targetId);

    // (2) The vector channel can. Measured rank 12 of 183 (#807: was 18 before the
    //     batch-invariance fix — the SAME symbol and the same model, ranked 6 places
    //     worse purely because ingest embedded it in a padded, quantized batch).
    //
    //     Asserted at 15, not 25. The old bound left room for "q8 jitter"; there is no
    //     jitter left to leave room for, because the vector is now a FUNCTION of the
    //     text (`tests/rag-embedder-batch-invariance.test.ts`). A bound that still
    //     tolerated the drift would tolerate the bug's return.
    const vectorStore = createSymbolVectorStore(realDeps);
    const { vectors } = await embedder.embed([NL_QUERY]);
    const vectorHits = await vectorStore.search(PROJECT, vectors[0], 183);
    const vectorRank = vectorHits.findIndex((h) => h.metadata.symbolId === targetId) + 1;
    expect(vectorRank).toBeGreaterThan(0);
    expect(vectorRank).toBeLessThanOrEqual(15);

    // (3) And it reaches the fused ranking. Measured 14 at #807's re-swept
    //     DEFAULT_WEIGHTS (0.05/0.95); it was 18 at #803's 0.15/0.85 on the old vectors.
    //
    //     The fused rank (14) is still WORSE than the vector rank (12), and that is
    //     inherent to RRF, not a leftover bug: a symbol both channels find collects
    //     `w_b/(k+r_b) + w_v/(k+r_v)`, a vector-only hit collects one term, and at any
    //     non-zero bm25Weight some dual-channel symbols will outscore it. What changed
    //     is that the vector channel's own rank (the floor RRF cannot beat) came down
    //     from 18 to 12, which is what put 15 within reach at all.
    const hybrid = hybridWith(vectorStore, embedder);
    const hits = await hybrid.search(NL_QUERY, PROJECT, { limit: 500, weights: DEFAULT_WEIGHTS });
    const hybridRank = hits.findIndex((h) => h.symbolId === targetId) + 1;
    expect(hybridRank).toBeGreaterThan(0);
    expect(hybridRank).toBeLessThanOrEqual(15);

    // eslint-disable-next-line no-console
    console.log(
      `\n[#797] embedder: ${embedder.model} (${probe.dimension}d, cls, q8)\n` +
        `[#797] query: "${NL_QUERY}"\n` +
        `[#797] ${TARGET_NAME}: BM25-only=ABSENT (0 hits in ${bm25Hits.length} ranked) ` +
        `| vector=rank ${vectorRank}/183 | hybrid=rank ${hybridRank}/183\n` +
        `[#797] hybrid top-5:\n` +
        hits
          .slice(0, 5)
          .map(
            (h, i) =>
              `  ${i + 1}. ${h.name.padEnd(24)} ${h.filePath.padEnd(30)} ${h.score.toFixed(5)}`,
          )
          .join("\n"),
    );
  }, 900_000);

  /**
   * PR #803 review (B1) — THE TOOL BOUNDARY. This is the test whose absence let the
   * gap hide, and as of #807 it is the test that closes it.
   *
   * Every assertion above measures a CHANNEL. The agent does not call a channel: it
   * calls `search_code_symbols`, which asks `createDefaultCodeSearcher()` for the top
   * `DEFAULT_LIMIT` hits and shows it nothing else. A symbol ranked below that limit
   * is, to the agent, exactly as absent as one BM25 never retrieved.
   *
   * #797 left this asserting `expect(returned).toBe(false)` — the honest state of the
   * feature at the time — with the instruction: "If a future change to the embedder,
   * the symbol text, or a re-ranker lifts the symbol into the top 15, THIS TEST WILL
   * FAIL. That failure is the good news, and the correct response is to flip the
   * assertion and celebrate it in the CHANGELOG — not to loosen it."
   *
   * #807 was that change to the embedder, and this is that flip. `assertWithinBudget`
   * now comes back at rank 14 of 183 for a requirement BM25 cannot retrieve at ANY
   * depth. What moved was the VECTOR, not the limit: `DEFAULT_LIMIT` is untouched at
   * 15 (raising it was explicitly off the table — that fits the limit to the answer),
   * and the vector channel's own rank fell 18 → 12 once embeddings stopped depending
   * on their ingest batch.
   *
   * This assertion is now the LOAD-BEARING one: if a regression re-batches the
   * quantized forward pass, the symbol drops back out of the agent's view and this
   * fails.
   */
  it("THE TOOL BOUNDARY: search_code_symbols now returns the symbol at its DEFAULT limit", async () => {
    const { Embedder } = await import("../rag/embedder.js");
    const embedder = new Embedder(realEmbedderConfig());
    const realDeps = { store, embedService: embedder, model: (): string => embedder.model };
    await embedProjectSymbols(PROJECT, realDeps);

    // The production factory, with the production Prisma symbol index — the exact
    // object `createSearchSymbolsTool()` builds when it is given no deps.
    const searcher = createDefaultCodeSearcher({
      vectorStore: createSymbolVectorStore(realDeps),
      symbolIndex: prismaSymbolIndex,
      embedService: embedder,
    });

    const atDefault = await searcher.search(NL_QUERY, PROJECT, { limit: DEFAULT_LIMIT });
    expect(atDefault).toHaveLength(DEFAULT_LIMIT);

    const returned = atDefault.map((h) => h.symbolId).includes(targetId);
    const rank = atDefault.findIndex((h) => h.symbolId === targetId) + 1;
    // eslint-disable-next-line no-console
    console.log(
      `\n[#807] TOOL BOUNDARY — search_code_symbols at DEFAULT_LIMIT=${DEFAULT_LIMIT}: ` +
        `${TARGET_NAME} ${returned ? `IS returned to the agent (rank ${rank})` : "is NOT returned to the agent"}.\n` +
        `[#807] top-${DEFAULT_LIMIT}: ${atDefault.map((h) => h.name).join(", ")}`,
    );

    // THE ACCEPTANCE CRITERION of #807, in executable form. See the block comment.
    expect(returned).toBe(true);
    expect(rank).toBeLessThanOrEqual(DEFAULT_LIMIT);

    // DEFAULT_LIMIT was NOT moved to make the line above pass — that was explicitly
    // forbidden, and it is the one change that would make this test lie. Pinned here
    // so a future "just bump the limit" edit fails loudly rather than quietly
    // re-satisfying the assertion above.
    expect(DEFAULT_LIMIT).toBe(15);
  }, 900_000);
});
