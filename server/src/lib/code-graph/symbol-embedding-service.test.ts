/**
 * Epic #780 / Issue #797 — the operator-facing half of the symbol-embedding
 * service: coverage accounting, the #787 reindex resume rules, drop, retag, and
 * the fire-and-forget ingest hook.
 *
 * The retrieval behaviour itself lives in `project-code-searcher.vector.test.ts`.
 * This file is about the things that decide whether an OPERATOR is told the truth
 * about their deployment — which is the failure mode #783/#787 exist to prevent
 * and the one #797 could most easily re-introduce.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalVectorStore, type VectorRow } from "../rag/vector-store.js";
import {
  MemoryReindexLeaseBackend,
  ReindexFencedError,
  __resetReindexLeaseBackend,
  reindexLockName,
} from "../rag/reindex-lease.js";
import type { EmbeddingResult } from "../rag/embedder.js";
import type { EmbedService } from "./symbol-embeddings.js";
import {
  createPrismaSymbolMetadataRepo,
  createSymbolEmbeddingStore,
  dropProjectSymbols,
  embedProjectSymbols,
  enqueueSymbolEmbeddings,
  getSymbolEmbeddingsPort,
  isEmbeddingSymbols,
  reindexProjectSymbols,
  retagSymbolsToActiveModel,
  symbolCoverage,
  symbolDeploymentCoverage,
  symbolReindexShadowId,
  symbolVectorsId,
  type SymbolMetadataRepo,
  type SymbolMetadataRow,
} from "./symbol-embedding-service.js";

// ---- Prisma mock ----------------------------------------------------------

interface Row {
  symbolId: string;
  projectId: string;
  text: string;
  contentHash: string;
  embeddingModel: string;
}
let rows: Row[] = [];

const mockFindMany = vi.fn(async ({ where }: { where?: Record<string, unknown> }) =>
  rows
    .filter((r) => !where?.projectId || r.projectId === where.projectId)
    .map((r) => ({
      ...r,
      symbol: {
        name: r.symbolId,
        qualifiedName: `q::${r.symbolId}`,
        kind: "function",
        filePath: `${r.symbolId}.ts`,
      },
    })),
);
const mockUpdateMany = vi.fn(
  async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
    let count = 0;
    for (const r of rows) {
      const sym = where.symbolId as string | { in?: string[] } | undefined;
      if (typeof sym === "string" && r.symbolId !== sym) continue;
      // `symbolId: { in: [...] }` — the snapshot-scoped retag (PR #803 review, M2).
      if (sym && typeof sym === "object" && !sym.in?.includes(r.symbolId)) continue;
      if (where.projectId && r.projectId !== where.projectId) continue;
      const model = where.embeddingModel as { not?: string; notIn?: string[] } | undefined;
      if (model?.not !== undefined && r.embeddingModel === model.not) continue;
      // `notIn` — the retag's PENDING exclusion (PR #803 review, B3).
      if (model?.notIn !== undefined && model.notIn.includes(r.embeddingModel)) continue;
      Object.assign(r, data);
      count += 1;
    }
    return { count };
  },
);
const mockGroupBy = vi.fn(
  async ({ by, where }: { by: string[]; where?: Record<string, unknown> }) => {
    const counts = new Map<string, { projectId: string; embeddingModel: string; n: number }>();
    for (const r of rows) {
      if (where?.projectId && r.projectId !== where.projectId) continue;
      const key = by.map((k) => String(r[k as keyof Row])).join("|");
      const entry = counts.get(key) ?? {
        projectId: r.projectId,
        embeddingModel: r.embeddingModel,
        n: 0,
      };
      entry.n += 1;
      counts.set(key, entry);
    }
    return [...counts.values()].map((e) => ({
      projectId: e.projectId,
      embeddingModel: e.embeddingModel,
      _count: { _all: e.n },
    }));
  },
);

/** The advisory-lock seam (PR #803 review, M1). Default answer: lock granted. */
const mockQueryRaw = vi.fn(async () => [{ locked: true }]);
const mockExecuteRaw = vi.fn(async () => 1);

vi.mock("../prisma.js", () => ({
  prisma: {
    codeSymbolEmbedding: {
      findMany: (...a: unknown[]) => mockFindMany(...(a as [never])),
      updateMany: (...a: unknown[]) => mockUpdateMany(...(a as [never])),
      groupBy: (...a: unknown[]) => mockGroupBy(...(a as [never])),
    },
    $queryRaw: (...a: unknown[]) => mockQueryRaw(...(a as [])),
    $executeRaw: (...a: unknown[]) => mockExecuteRaw(...(a as [])),
  },
}));

// ---- Helpers --------------------------------------------------------------

const MODEL = "fake-model-v1";
const PROJECT = "p1";

function embedder(model = MODEL): EmbedService & { model: string } {
  return {
    model,
    async embed(texts: string[]): Promise<EmbeddingResult> {
      return {
        vectors: texts.map((t) => [t.length, t.charCodeAt(0) || 1, 1]),
        model,
        dimension: 3,
      };
    },
  };
}

let root: string;
let store: LocalVectorStore;

function deps(e: EmbedService & { model: string } = embedder()) {
  return { store, embedService: e, model: (): string => e.model };
}

beforeEach(() => {
  vi.clearAllMocks();
  // #876 — Prisma is stubbed here, so the reindex lease must resolve to the no-op backend.
  // `resolveReindexLeaseBackend()` reads `DATABASE_URL` lazily, so an ambient Postgres URL
  // (a developer dogfooding on Postgres) would otherwise wire a real
  // `PostgresReindexLeaseBackend` to the mock and fail on `$executeRawUnsafe`. The one test
  // below that WANTS a Postgres datasource sets it explicitly and injects its own backend.
  delete process.env.DATABASE_URL;
  __resetReindexLeaseBackend();
  rows = [
    { symbolId: "s1", projectId: PROJECT, text: "alpha", contentHash: "", embeddingModel: "" },
    { symbolId: "s2", projectId: PROJECT, text: "bravo", contentHash: "", embeddingModel: "" },
    { symbolId: "s3", projectId: "p2", text: "charlie", contentHash: "", embeddingModel: "old" },
  ];
  root = path.join(os.tmpdir(), `symsvc-${Math.random().toString(36).slice(2)}`);
  store = new LocalVectorStore({ root });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

// ---- Namespaces -----------------------------------------------------------

describe("namespaces", () => {
  it("keeps symbol vectors in their own namespace, beside the document ones", () => {
    // Document chunks live under the bare projectId; symbols must NOT collide with
    // them, or a document reindex would swap a table holding both.
    expect(symbolVectorsId("abc")).toBe("abc__symbols");
    expect(symbolReindexShadowId("abc")).toBe("abc__symbols__reindex");
  });
});

// ---- Coverage accounting (#787 status) ------------------------------------

describe("coverage accounting", () => {
  it("reports pending symbols (embeddingModel = '') distinctly from embedded ones", async () => {
    rows[0].embeddingModel = MODEL;
    const coverage = await symbolCoverage(PROJECT);
    expect(coverage.totalSymbols).toBe(2);
    // "" is PENDING — a row ingest wrote whose vector the job has not computed. If
    // this were folded into the active-model count, `embed-migrate status` would
    // report a green deployment with half its symbols unembedded.
    expect(coverage.modelCounts).toEqual({ [MODEL]: 1, "": 1 });
  });

  it("rolls per-model symbol counts up across every project", async () => {
    const byProject = await symbolDeploymentCoverage();
    expect(byProject.get(PROJECT)).toEqual({ "": 2 });
    expect(byProject.get("p2")).toEqual({ old: 1 });
  });
});

// ---- Retag / drop ---------------------------------------------------------

describe("retag + drop", () => {
  it("retags only the EMBEDDED rows that disagree with the active model", async () => {
    rows[0].embeddingModel = MODEL;
    const count = await retagSymbolsToActiveModel({ model: () => MODEL, store });
    // s3 ("old") only. s1 already matched; s2 is PENDING and must be left alone.
    expect(count).toBe(1);
    expect(rows.find((r) => r.symbolId === "s3")?.embeddingModel).toBe(MODEL);
  });

  it("NEVER sweeps a PENDING row into the active model (PR #803 review, B3)", async () => {
    // The false-green this whole module's accounting exists to prevent. `s2` is
    // PENDING: ingest wrote the row, the background job has not embedded it, and NO
    // VECTOR EXISTS for it. The document-shaped retag (`{ not: activeModel }`) also
    // matches `""`, so it would tag `s2` as live at the active model — after which
    // `coverage()` counts it as migrated, `needsReindex` goes false, and
    // `pnpm embed-migrate status` reports a green, fully-migrated deployment over a
    // symbol with no vector. The operator is lied to, and nothing surfaces it.
    rows[0].embeddingModel = MODEL;
    expect(rows.find((r) => r.symbolId === "s2")?.embeddingModel).toBe("");

    await retagSymbolsToActiveModel({ model: () => MODEL, store });

    // Still PENDING. Still visible. Still owed an embed.
    expect(rows.find((r) => r.symbolId === "s2")?.embeddingModel).toBe("");
    const coverage = await symbolCoverage(PROJECT);
    expect(coverage.modelCounts).toEqual({ [MODEL]: 1, "": 1 });
  });

  it("drops the live namespace AND its reindex shadow", async () => {
    await store.ensureTable(symbolVectorsId(PROJECT));
    await store.ensureTable(symbolReindexShadowId(PROJECT));
    const spy = vi.spyOn(store, "dropTable");

    await dropProjectSymbols(PROJECT, { store });

    // A retained shadow must not outlive the project it is a checkpoint OF.
    expect(spy).toHaveBeenCalledWith(symbolVectorsId(PROJECT));
    expect(spy).toHaveBeenCalledWith(symbolReindexShadowId(PROJECT));
  });

  it("a drop failure does not throw (archive must not be blocked by a vector table)", async () => {
    vi.spyOn(store, "dropTable").mockRejectedValue(new Error("backend down"));
    await expect(dropProjectSymbols(PROJECT, { store })).resolves.toBeUndefined();
  });
});

// ---- Reindex resume rules (#787) -----------------------------------------

describe("reindexProjectSymbols", () => {
  it("is a clean no-op for a project with no symbols, and clears a junk shadow", async () => {
    rows = [];
    await store.ensureTable(symbolReindexShadowId(PROJECT));
    const spy = vi.spyOn(store, "dropTable");

    const result = await reindexProjectSymbols(PROJECT, deps());

    expect(result.totalSymbols).toBe(0);
    expect(result.embeddedSymbols).toBe(0);
    expect(spy).toHaveBeenCalledWith(symbolReindexShadowId(PROJECT));
  });

  it("RESUMES a shadow left by an interrupted run instead of re-embedding it", async () => {
    const e = embedder();
    // A previous run got as far as s1 and died.
    const shadow = symbolReindexShadowId(PROJECT);
    await store.ensureTable(shadow);
    const row: VectorRow = {
      id: "s1",
      vector: [1, 2, 3],
      metadata: {
        chunkId: "s1",
        documentId: "s1",
        filename: "s1.ts",
        position: 0,
        text: "alpha",
        embeddingModel: MODEL,
      },
    };
    await store.upsert(shadow, [row]);

    const result = await reindexProjectSymbols(PROJECT, deps(e));

    expect(result.resumedSymbols).toBe(1);
    expect(result.embeddedSymbols).toBe(1); // only s2 was re-embedded
    expect(result.totalSymbols).toBe(2);
  });

  it("DISCARDS a shadow built by another model rather than mixing vector spaces", async () => {
    const shadow = symbolReindexShadowId(PROJECT);
    await store.ensureTable(shadow);
    await store.upsert(shadow, [
      {
        id: "s1",
        vector: [9, 9, 9],
        metadata: {
          chunkId: "s1",
          documentId: "s1",
          filename: "s1.ts",
          position: 0,
          text: "alpha",
          embeddingModel: "an-abandoned-model",
        },
      },
    ]);

    const result = await reindexProjectSymbols(PROJECT, deps());

    // Resuming would have built ONE table out of TWO vector spaces — the exact
    // thing model-tagging exists to prevent. A clean rebuild is the only answer.
    expect(result.resumedSymbols).toBe(0);
    expect(result.embeddedSymbols).toBe(2);
  });

  it("fresh: true ignores a perfectly resumable shadow", async () => {
    const shadow = symbolReindexShadowId(PROJECT);
    await store.ensureTable(shadow);
    await store.upsert(shadow, [
      {
        id: "s1",
        vector: [1, 2, 3],
        metadata: {
          chunkId: "s1",
          documentId: "s1",
          filename: "s1.ts",
          position: 0,
          text: "alpha",
          embeddingModel: MODEL,
        },
      },
    ]);

    const result = await reindexProjectSymbols(PROJECT, { ...deps(), fresh: true });
    expect(result.resumedSymbols).toBe(0);
    expect(result.embeddedSymbols).toBe(2);
  });

  it("prunes shadow rows for symbols that no longer exist", async () => {
    const shadow = symbolReindexShadowId(PROJECT);
    await store.ensureTable(shadow);
    await store.upsert(shadow, [
      {
        id: "gone",
        vector: [1, 2, 3],
        metadata: {
          chunkId: "gone",
          documentId: "gone",
          filename: "gone.ts",
          position: 0,
          text: "x",
          embeddingModel: MODEL,
        },
      },
    ]);

    const result = await reindexProjectSymbols(PROJECT, deps());

    // Left in place, `gone` would survive the swap as a live orphan.
    expect(result.resumedSymbols).toBe(0);
    expect(await store.count(symbolVectorsId(PROJECT))).toBe(2);
  });

  it("tags ONLY the snapshot — a row ingested mid-run stays PENDING (PR #803 review, M2)", async () => {
    // The race: `reindexProjectSymbols` snapshots the rows, embeds them, swaps the
    // table, then reconciles the Prisma tags. A connector ingest that lands between
    // the snapshot and the reconcile inserts rows this run never embedded and whose
    // vectors the swap therefore did not write. Scoped by `projectId`, the reconcile
    // would tag them at the active model anyway — claiming vectors that do not exist,
    // the same false-green as B3, arrived at by a race instead of a query bug.
    const racing: EmbedService & { model: string } = {
      model: MODEL,
      async embed(texts: string[]): Promise<EmbeddingResult> {
        // A concurrent ingest, mid-flight, exactly as `ingestCodeGraph` writes it.
        if (!rows.some((r) => r.symbolId === "s-late")) {
          rows.push({
            symbolId: "s-late",
            projectId: PROJECT,
            text: "late arrival",
            contentHash: "",
            embeddingModel: "",
          });
        }
        return embedder().embed(texts);
      },
    };

    const result = await reindexProjectSymbols(PROJECT, deps(racing));

    expect(result.totalSymbols).toBe(2); // the snapshot, not the post-race table
    // s1/s2 were embedded and swapped in — they are legitimately live.
    expect(rows.find((r) => r.symbolId === "s1")?.embeddingModel).toBe(MODEL);
    expect(rows.find((r) => r.symbolId === "s2")?.embeddingModel).toBe(MODEL);
    // s-late was NOT embedded and has NO vector. It must still say so.
    expect(rows.find((r) => r.symbolId === "s-late")?.embeddingModel).toBe("");
  });

  it("refuses a vector count that disagrees with the batch it was given", async () => {
    const broken: EmbedService & { model: string } = {
      model: MODEL,
      async embed(): Promise<EmbeddingResult> {
        return { vectors: [[1, 2, 3]], model: MODEL, dimension: 3 }; // 1 vector for 2 texts
      },
    };
    await expect(reindexProjectSymbols(PROJECT, deps(broken))).rejects.toThrow(
      /returned 1 vectors for 2 symbols/,
    );
  });
});

// ---- The in-process guard + the ingest hook -------------------------------

describe("the embed job guard", () => {
  it("refuses a second concurrent run for the same project", async () => {
    const gate = Promise.withResolvers<void>();
    const slow: EmbedService & { model: string } = {
      model: MODEL,
      async embed(texts: string[]): Promise<EmbeddingResult> {
        await gate.promise;
        return embedder().embed(texts);
      },
    };

    const first = embedProjectSymbols(PROJECT, deps(slow));
    expect(isEmbeddingSymbols(PROJECT)).toBe(true);
    await expect(embedProjectSymbols(PROJECT, deps())).rejects.toThrow(/already in progress/);

    gate.resolve();
    await first;
    expect(isEmbeddingSymbols(PROJECT)).toBe(false);
  });

  it("takes the project's REINDEX LEASE — never a session advisory lock (PR #803 review, D3)", async () => {
    // The regression guard for the leak #798 removed. An earlier round of this PR guarded
    // the symbol corpus with `pg_try_advisory_lock('symbol-embed:...')` + a separate
    // `pg_advisory_unlock` outside any `$transaction` — which, through Prisma's pool, can
    // release on a DIFFERENT backend than it acquired on, discard the `false`, and leak
    // the lock until the pod restarts (#798 measured 8 leaks in 8 cycles). A leaked
    // SYMBOL lock was worse than a leaked document one: it wedged phase 2 of every future
    // reindex, throwing AFTER the document swap had committed. One mechanism now.
    const be = new MemoryReindexLeaseBackend();
    process.env.DATABASE_URL = "postgresql://user:pw@localhost:5432/metis";
    try {
      await embedProjectSymbols(PROJECT, { ...deps(), leaseBackend: be });
      const sql = mockQueryRaw.mock.calls.map((c) => String(c[0])).join(" ");
      expect(sql).not.toContain("pg_try_advisory_lock");
      expect(mockExecuteRaw).not.toHaveBeenCalled();
      // And the lease it DID take is released on the way out — no wedge.
      expect(await be.read(reindexLockName(PROJECT))).toBeNull();
    } finally {
      // `beforeEach` re-pins the datasource for the next test; `= prev` would have written
      // the literal string "undefined" once `prev` became unset (#876).
      delete process.env.DATABASE_URL;
    }
  });

  it("refuses to start when ANOTHER replica holds the project's lease", async () => {
    const be = new MemoryReindexLeaseBackend();
    await be.acquire(reindexLockName(PROJECT), "pod-b:run-1", Date.now(), 120_000);

    await expect(embedProjectSymbols(PROJECT, { ...deps(), leaseBackend: be })).rejects.toThrow(
      /already in progress/,
    );

    // The other replica still holds it — we must not have released or stolen it.
    expect((await be.read(reindexLockName(PROJECT)))?.holder).toBe("pod-b:run-1");
    expect(isEmbeddingSymbols(PROJECT)).toBe(false);
  });

  it("the reindex takes the SAME lease, so a model swap cannot land mid-embed", async () => {
    // ONE key, deliberately (`reindex:<projectId>`, not a sibling `symbol-embed:` one):
    // the document reindex's phase 2 mutates the symbol corpus while holding THIS lease,
    // so anything that must exclude phase 2 has to contend for THIS name. Two names would
    // be two mechanisms again, and the archive's force-take would fence only one of them.
    const be = new MemoryReindexLeaseBackend();
    await be.acquire(reindexLockName(PROJECT), "pod-b:run-1", Date.now(), 120_000);

    await expect(reindexProjectSymbols(PROJECT, { ...deps(), leaseBackend: be })).rejects.toThrow(
      /already in progress/,
    );
  });

  it("enqueueSymbolEmbeddings never throws when the job fails — ingest must not fail with it", async () => {
    // The default deps reach for the real embedder/store; in this suite that will
    // fail. The point is precisely that it is SWALLOWED: the CodeSymbolEmbedding
    // rows are already durable, so a failed embed degrades search to BM25 and the
    // next ingest or reindex picks the work back up.
    expect(() => enqueueSymbolEmbeddings("no-such-project")).not.toThrow();
  });
});

// ---- The fence ------------------------------------------------------------

/**
 * PR #803 review (D1/D2) — the two races that a FAKE `SymbolEmbeddingsPort` cannot see.
 *
 * The merge of #797 into #798 put the symbol work lexically INSIDE the lease callback and
 * called it fenced. It was not. Lexical nesting orders two mutations within one process;
 * it re-proves ownership of nothing. These tests exercise the REAL guard-threading path —
 * a real lease backend, the real store, the real `swapTable` — because that is the only
 * place the fence exists. Delete the `fence.renew()` / `fence.assertHeld()` /
 * `swapTable(…, fence)` calls and both of these go red.
 */
describe("the reindex fence", () => {
  /** Force-take the project's lease, exactly as `KnowledgeService.dropProject` does. */
  async function forceTake(be: MemoryReindexLeaseBackend, holder: string): Promise<void> {
    await be.acquire(reindexLockName(PROJECT), holder, Date.now(), 120_000, { force: true });
  }

  const pendingTags = (): string[] =>
    rows.filter((r) => r.projectId === PROJECT).map((r) => r.embeddingModel);

  it("D1: a lease stolen mid-phase-2 stops the symbol SWAP and the Prisma RETAG", async () => {
    const be = new MemoryReindexLeaseBackend();
    const swap = vi.spyOn(store, "swapTable");

    let batches = 0;
    const stealMidRun: EmbedService & { model: string } = {
      model: MODEL,
      async embed(texts: string[]): Promise<EmbeddingResult> {
        batches += 1;
        // Batch 2 is in flight when an archive force-takes the lease. Batch 1's shadow
        // rows are already written; from this instant the run is FENCED.
        if (batches === 2) await forceTake(be, "archive:run-1");
        return embedder().embed(texts);
      },
    };

    await expect(
      reindexProjectSymbols(PROJECT, {
        ...deps(stealMidRun),
        leaseBackend: be,
        batchSize: 1,
        fresh: true,
      }),
    ).rejects.toBeInstanceOf(ReindexFencedError);

    expect(batches).toBe(2);
    // The cut-over is what RESURRECTS an archived project's symbol table out of a fenced
    // run's shadow. Unguarded, `swapTable` "behaves exactly as before #798" — so it must
    // not even be attempted.
    expect(swap).not.toHaveBeenCalled();
    const live = await store.listChunkRefs(symbolVectorsId(PROJECT)).catch(() => []);
    expect(live).toEqual([]);
    // …and Prisma must not claim a migration that never landed. Both rows stay PENDING.
    expect(pendingTags()).toEqual(["", ""]);
  });

  it("D2: an archive's drop is not undone by the background embed it fenced", async () => {
    // `enqueueSymbolEmbeddings` fires `embedProjectSymbols` from EVERY code-graph ingest.
    // Before the fix that job wrote into the LIVE `<projectId>__symbols` namespace with no
    // guard whatsoever, so an archive that dropped the table mid-run had it written
    // straight back: ~15k orphan vectors for a project that no longer exists.
    const be = new MemoryReindexLeaseBackend();
    const gate = Promise.withResolvers<void>();
    const reached = Promise.withResolvers<void>();
    const slow: EmbedService & { model: string } = {
      model: MODEL,
      async embed(texts: string[]): Promise<EmbeddingResult> {
        reached.resolve();
        await gate.promise;
        return embedder().embed(texts);
      },
    };

    const job = embedProjectSymbols(PROJECT, { ...deps(slow), leaseBackend: be, batchSize: 2 });
    await reached.promise; // the job holds the lease and is out at the embedder

    // The archive, as `KnowledgeService.dropProject` performs it: force-take the lease
    // (revoking the job's fencing token), then drop.
    await forceTake(be, "archive:run-1");
    await dropProjectSymbols(PROJECT, { store });

    gate.resolve();
    await expect(job).rejects.toBeInstanceOf(ReindexFencedError);

    const live = await store.listChunkRefs(symbolVectorsId(PROJECT)).catch(() => []);
    expect(live).toEqual([]);
    expect(pendingTags()).toEqual(["", ""]);
  });
});

// ---- The store adapter's orphan rule --------------------------------------

describe("createSymbolEmbeddingStore", () => {
  it("treats a vector with no metadata row as an orphan so the pipeline prunes it", async () => {
    const symbolStore = createSymbolEmbeddingStore(deps());
    await store.ensureTable(symbolVectorsId(PROJECT));
    await store.upsert(symbolVectorsId(PROJECT), [
      {
        id: "orphan",
        vector: [1, 2, 3],
        metadata: {
          chunkId: "orphan",
          documentId: "orphan",
          filename: "x.ts",
          position: 0,
          text: "x",
          embeddingModel: MODEL,
        },
      },
    ]);

    const hashes = await symbolStore.getExistingHashes(PROJECT);

    // Present (so the pipeline sees it and can prune it) but with a hash that can
    // never match a real one — the Prisma row is gone, cascaded away with its
    // symbol, so the vector is the ONLY trace left of it.
    expect(hashes.has("orphan")).toBe(true);
    expect(hashes.get("orphan")).not.toBe("");
  });

  it("ignores vectors tagged with a non-active model when computing skip-keys", async () => {
    const symbolStore = createSymbolEmbeddingStore(deps());
    await store.ensureTable(symbolVectorsId(PROJECT));
    await store.upsert(symbolVectorsId(PROJECT), [
      {
        id: "s1",
        vector: [1, 2, 3],
        metadata: {
          chunkId: "s1",
          documentId: "s1",
          filename: "s1.ts",
          position: 0,
          text: "alpha",
          embeddingModel: "previous-generation",
        },
      },
    ]);

    // An old-generation vector is not a reason to SKIP re-embedding a symbol.
    expect(await symbolStore.getExistingHashes(PROJECT)).toEqual(new Map());
  });
});

// ---- The Prisma repo + the port -------------------------------------------

describe("the Prisma metadata repo and the KnowledgeService port", () => {
  it("joins CodeSymbolEmbedding to its CodeSymbol", async () => {
    const repo = createPrismaSymbolMetadataRepo();
    const listed = await repo.list(PROJECT);
    expect(listed).toHaveLength(2);
    expect(listed[0]).toMatchObject({ symbolId: "s1", text: "alpha", filePath: "s1.ts" });
  });

  it("tags rows through updateMany", async () => {
    const repo = createPrismaSymbolMetadataRepo();
    await repo.tag(PROJECT, [{ symbolId: "s1", contentHash: "h", embeddingModel: MODEL }]);
    expect(rows.find((r) => r.symbolId === "s1")).toMatchObject({
      contentHash: "h",
      embeddingModel: MODEL,
    });
  });

  it("exposes exactly the surface KnowledgeService reindex/coverage needs", () => {
    const port = getSymbolEmbeddingsPort();
    for (const fn of [
      "coverage",
      "deploymentCoverage",
      "reindexProject",
      "dropProject",
      "retagToActiveModel",
    ] as const) {
      expect(typeof port[fn]).toBe("function");
    }
  });
});

// ---- A custom repo (the seam the eval rides) ------------------------------

describe("the metadata repo seam", () => {
  it("lets a caller drive the production pipeline with no database", async () => {
    const memory: SymbolMetadataRow[] = [
      {
        symbolId: "m1",
        text: "in-memory symbol",
        contentHash: "",
        embeddingModel: "",
        name: "m1",
        qualifiedName: "q::m1",
        kind: "function",
        filePath: "m1.ts",
      },
    ];
    const repo: SymbolMetadataRepo = {
      async list() {
        return memory.map((r) => ({ ...r }));
      },
      async listHashes() {
        return memory.map((r) => ({
          symbolId: r.symbolId,
          contentHash: r.contentHash,
          embeddingModel: r.embeddingModel,
        }));
      },
      async tag(_p, tagged) {
        for (const t of tagged) {
          const row = memory.find((r) => r.symbolId === t.symbolId);
          if (row) Object.assign(row, t);
        }
      },
    };

    const result = await embedProjectSymbols(PROJECT, { ...deps(), repo });

    expect(result.embedded).toBe(1);
    expect(memory[0].embeddingModel).toBe(MODEL);
    expect(await store.count(symbolVectorsId(PROJECT))).toBe(1);
    // Prisma was never touched.
    expect(mockFindMany).not.toHaveBeenCalled();
  });
});
