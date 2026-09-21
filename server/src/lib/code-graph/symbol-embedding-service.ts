/**
 * Epic #780 / Issue #797 — the production symbol-embedding store, and the job
 * that fills it.
 *
 * ## What was broken
 *
 * `search_code_symbols` was BM25-ONLY in production. `project-code-searcher.ts`
 * handed `HybridCodeSearch` a no-op vector store and an empty embed service, so
 * the vector branch never ran. #780's embedder upgrade (gte-modernbert, 0.402 vs
 * 0.246 nDCG@10 in #788) therefore reached document chunks and nothing else:
 * there was no vector half of code search to improve. This module is the missing
 * half.
 *
 * ## Where the data lives, and why it is split in two
 *
 *   - **Vectors → the existing {@link VectorStore}**, under the synthetic
 *     namespace `<projectId>__symbols` ({@link symbolVectorsId}). The repo
 *     already decided vectors do not go in Prisma: a `vector(N)` column's width
 *     is derived at runtime from the active embedder and a static migration
 *     cannot express it (see the header of `vector-store-pgvector.ts`), and
 *     SQLite has no vector type at all. Riding the existing store means symbol
 *     vectors work on all three wired backends — pgvector (prod), Lance
 *     (default), local JSON (tests) — and inherit `ensureTable` / `swapTable` /
 *     `listChunkRefs`, i.e. #787's shadow-and-resume machinery, for free. The
 *     namespace trick is not new either: `reindexShadowId` already mints
 *     `<projectId>__reindex` the same way.
 *
 *   - **Text + hash + model tag → Prisma (`CodeSymbolEmbedding`).** The vector
 *     store flattens metadata onto a fixed column set, so arbitrary symbol
 *     fields would be silently dropped on pgvector. More importantly, the text
 *     a symbol was embedded FROM cannot be reconstructed from the database:
 *     `formatSymbolForEmbedding` needs the signature, docstring and body, and
 *     `CodeSymbol` stores none of them. Persisting the text is what lets an
 *     #787 model flip re-embed every symbol with NO repo checkout.
 *
 * ## The model tag is the safety property
 *
 * Every search filters to `getEmbedder().model`. A row embedded by a previous
 * generation (or by the hash stub) is IGNORED, never compared — the same
 * invariant `KnowledgeService.search()` relies on. Mixing two vector spaces in
 * one ranking is the failure mode the tag exists to prevent.
 */
import { prisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";
import { getEmbedder } from "../rag/embedder.js";
import { MAX_EMBED_TEXTS_PER_REQUEST } from "../rag/embed-model-config.js";
import {
  ReindexConflictError,
  ReindexFencedError,
  withReindexLease,
  type ReindexFence,
  type ReindexLeaseBackend,
} from "../rag/reindex-lease.js";
import { getVectorStore, type VectorRow, type VectorStore } from "../rag/vector-store.js";
import type { SymbolVectorStore, VectorSearchHit } from "./hybrid-search.js";
import {
  SymbolEmbeddingPipeline,
  type EmbedService,
  type PipelineResult,
  type SymbolEmbeddingRow,
  type SymbolEmbeddingStore,
  type SymbolForEmbedding,
  type SymbolKind,
} from "./symbol-embeddings.js";

const log = createChildLogger("symbol-embeddings-service");

/** Namespace holding a project's LIVE symbol vectors inside the shared store. */
export function symbolVectorsId(projectId: string): string {
  return `${projectId}__symbols`;
}

/** Namespace of the transient shadow a symbol re-index builds into (#787). */
export function symbolReindexShadowId(projectId: string): string {
  return `${projectId}__symbols__reindex`;
}

/**
 * Sentinel hash for a vector row with no `CodeSymbolEmbedding` behind it.
 *
 * A vector whose symbol has been deleted is an ORPHAN and must be pruned. It can
 * only be spotted from the store side (the Prisma row is already gone, cascaded
 * away with the `CodeSymbol`), so `getExistingHashes` reports it with a hash that
 * can never match a real one — the pipeline then finds it absent from the current
 * symbol set and deletes it.
 *
 * The NUL is written as an ESCAPE, never as a literal control byte in the source:
 * a raw 0x00 makes git classify this file as BINARY, and it then silently loses
 * its diff, its blame, its inline review comments and its Semgrep pass while every
 * check stays green (PR #803 review, B2). The runtime value is identical, and a
 * SHA-256 hex digest can never collide with it either way.
 */
const ORPHAN_HASH = "\u0000orphan";

/**
 * PENDING — `ingestCodeGraph` wrote the `CodeSymbolEmbedding` row, but nothing has
 * embedded the symbol yet, so NO VECTOR EXISTS for it.
 *
 * A symbol-only state, and the reason the document-shaped operations cannot be
 * reused verbatim here: a `KnowledgeChunk` gets its vector written synchronously at
 * ingest, so a document row is never tagged-but-vectorless. A symbol row can be.
 */
const PENDING_MODEL = "";

/** Max ids per `IN (...)` when reconciling tags after a reindex. */
const RETAG_CHUNK = 1000;

// ---- Dependencies (injectable for tests) ----------------------------------

export interface SymbolEmbeddingDeps {
  store?: VectorStore;
  embedService?: EmbedService;
  /** Model id the vectors are tagged with / filtered by. Defaults to the active embedder's. */
  model?: () => string;
  /** Where the durable symbol metadata lives. Defaults to Prisma. */
  repo?: SymbolMetadataRepo;
  /**
   * Issue #798 / PR #803 review — the reindex fence this run must re-prove ownership of
   * before EVERY write to the project's symbol vectors.
   *
   * Supplied by the caller when it ALREADY holds the project's lease (the document
   * reindex's phase 2, the archive's force-taken lease). When absent, the entry points
   * that mutate ({@link embedProjectSymbols}, {@link reindexProjectSymbols}) take the
   * lease themselves. There is no third option: an unfenced write to the live symbol
   * namespace is the D1/D2 defect.
   */
  fence?: ReindexFence;
  /** Test seam — the lease backend to take the fence from. Defaults to the resolved one. */
  leaseBackend?: ReindexLeaseBackend;
}

/** The four collaborators every symbol operation needs, with defaults applied. */
type ResolvedSymbolDeps = Required<
  Pick<SymbolEmbeddingDeps, "store" | "embedService" | "model" | "repo">
>;

/** One symbol's durable embedding metadata (a `CodeSymbolEmbedding` row). */
export interface SymbolMetadataRow {
  symbolId: string;
  text: string;
  contentHash: string;
  embeddingModel: string;
  name: string;
  qualifiedName: string;
  kind: string;
  filePath: string;
}

/**
 * The durable metadata side of a symbol embedding, behind a seam.
 *
 * Production backs this with Prisma. The seam exists so #788's retrieval eval can
 * score the REAL production write + read path — the real pipeline, the real store
 * adapter, the real model-tag filter — against the committed corpus WITHOUT
 * standing up a database and faking a code-graph ingest into it. Without the seam
 * the eval would have to rebuild those pieces, and then it would once again be
 * measuring something other than what production runs, which is the entire defect
 * #797 is about.
 */
export interface SymbolMetadataRepo {
  list(projectId: string): Promise<SymbolMetadataRow[]>;
  /**
   * The hash/model tag alone, with no `text` and no `symbol` join. Deep-ingest of a
   * large repo can carry tens of thousands of symbols, each with a full-body embed
   * text; `getExistingHashes` only compares hashes, so pulling `text` for every row
   * just to discard it materializes the whole corpus in memory for nothing (crashed
   * the dev server with a heap OOM mid-ingest — 2026-09-03).
   */
  listHashes(
    projectId: string,
  ): Promise<Array<{ symbolId: string; contentHash: string; embeddingModel: string }>>;
  /** Set the content hash + model tag for symbols whose vectors were just written. */
  tag(
    projectId: string,
    rows: Array<{ symbolId: string; contentHash: string; embeddingModel: string }>,
  ): Promise<void>;
}

/** The default {@link SymbolMetadataRepo} — `CodeSymbolEmbedding` joined to `CodeSymbol`. */
export function createPrismaSymbolMetadataRepo(): SymbolMetadataRepo {
  return {
    async list(projectId: string): Promise<SymbolMetadataRow[]> {
      const rows = await prisma.codeSymbolEmbedding.findMany({
        where: { projectId },
        select: {
          symbolId: true,
          text: true,
          contentHash: true,
          embeddingModel: true,
          symbol: { select: { name: true, qualifiedName: true, kind: true, filePath: true } },
        },
      });
      return rows.map((r) => ({
        symbolId: r.symbolId,
        text: r.text,
        contentHash: r.contentHash,
        embeddingModel: r.embeddingModel,
        name: r.symbol.name,
        qualifiedName: r.symbol.qualifiedName,
        kind: r.symbol.kind,
        filePath: r.symbol.filePath,
      }));
    },
    async listHashes(projectId: string) {
      return prisma.codeSymbolEmbedding.findMany({
        where: { projectId },
        select: { symbolId: true, contentHash: true, embeddingModel: true },
      });
    },
    async tag(_projectId, rows): Promise<void> {
      for (const row of rows) {
        await prisma.codeSymbolEmbedding.updateMany({
          where: { symbolId: row.symbolId },
          data: { contentHash: row.contentHash, embeddingModel: row.embeddingModel },
        });
      }
    },
  };
}

function resolveDeps(deps: SymbolEmbeddingDeps = {}): ResolvedSymbolDeps {
  return {
    store: deps.store ?? getVectorStore(),
    // NOTE: `Embedder.embed(texts) => { vectors, model, dimension }` is already
    // exactly `EmbedService`. Reuse the SINGLETON — never construct a second
    // Embedder and never read EMBED_POOLING/EMBED_DTYPE here. Index-side and
    // query-side must be the same object or #792's train/serve skew is back.
    embedService: deps.embedService ?? getEmbedder(),
    model: deps.model ?? ((): string => getEmbedder().model),
    repo: deps.repo ?? createPrismaSymbolMetadataRepo(),
  };
}

// ---- SymbolEmbeddingStore (Prisma metadata + VectorStore vectors) ----------

/**
 * The concrete {@link SymbolEmbeddingStore} the #508 pipeline was always missing.
 *
 * It does NOT create `CodeSymbolEmbedding` rows — ingest does that, while the
 * source file is still in memory and the text can actually be formatted. This
 * store only ever reconciles an existing row's vector + model tag, which is why
 * `upsert` uses `updateMany` and not `upsert`.
 */
export function createSymbolEmbeddingStore(deps: SymbolEmbeddingDeps = {}): SymbolEmbeddingStore {
  const { store, model, repo } = resolveDeps(deps);
  const fence = deps.fence;

  /**
   * PR #803 review (D2) — re-prove the fence IMMEDIATELY before every write to the LIVE
   * symbol namespace.
   *
   * This is the guard `dropProjectSymbols` needs in order to exclude a background
   * `embedProjectSymbols`. The archive FORCE-TAKES the project's lease, which revokes
   * this run's fencing token; without this check the embed job would carry on writing
   * vectors into `<projectId>__symbols` for a project that has just been archived and
   * whose table has just been dropped — recreating it, and leaving ~15k orphan vectors
   * behind. Zero rows renewed ⇒ we were fenced ⇒ abort before mutating.
   *
   * The residue is the SAME bounded one the document path documents (`dropProject()`):
   * renew-then-upsert is two statements, so a run fenced in the gap can still land the
   * batch already in flight. What it cannot do is keep going.
   */
  const assertNotFenced = async (): Promise<void> => {
    if (!fence) return;
    if (!(await fence.renew())) throw new ReindexFencedError(fence.projectId, fence.holder);
  };

  return {
    async getExistingHashes(projectId: string): Promise<Map<string, string>> {
      const ns = symbolVectorsId(projectId);
      const activeModel = model();
      // Start from the STORE, not from the metadata rows: a hash is only a valid
      // skip-key if the vector it describes ACTUALLY EXISTS, at the active model. A
      // row can be tagged while its vector was never written (a crash between the
      // two writes), and a vector can outlive its row (its symbol was deleted).
      const refs = await store.listChunkRefs(ns).catch(() => []);
      const live = refs.filter((r) => r.embeddingModel === activeModel).map((r) => r.chunkId);
      if (live.length === 0) return new Map();

      const rows = await repo.listHashes(projectId);
      const byId = new Map(
        rows
          .filter((r) => r.embeddingModel === activeModel)
          .map((r) => [r.symbolId, r.contentHash] as const),
      );

      const out = new Map<string, string>();
      for (const id of live) out.set(id, byId.get(id) ?? ORPHAN_HASH);
      return out;
    },

    async upsert(projectId: string, rows: SymbolEmbeddingRow[]): Promise<void> {
      if (rows.length === 0) return;
      const ns = symbolVectorsId(projectId);
      await assertNotFenced();
      await store.ensureTable(ns);
      await store.upsert(ns, rows.map(toVectorRow));

      // Reconcile the durable tags AFTER the vectors are written, so the DB never
      // claims a vector that does not exist (the same ordering `runReindex` uses).
      await repo.tag(
        projectId,
        rows.map((r) => ({
          symbolId: r.metadata.symbolId,
          contentHash: r.metadata.contentHash,
          embeddingModel: r.metadata.embeddingModel ?? "",
        })),
      );
    },

    async deleteBySymbolIds(projectId: string, symbolIds: string[]): Promise<number> {
      if (symbolIds.length === 0) return 0;
      await assertNotFenced();
      return store.deleteByChunkIds(symbolVectorsId(projectId), symbolIds);
    },
  };
}

/**
 * Map a symbol row onto the vector store's fixed column set.
 *
 * The store flattens `metadata` to `(id, vector, text, document_id, chunk_index,
 * filename, model, created_at)` on every backend — anything else is dropped on
 * the floor by pgvector's row mapper. So we MAP rather than extend: the vector id
 * IS the symbol id (which is what `listChunkRefs`, `deleteByChunkIds` and the
 * search-time reconstitution all key on).
 */
function toVectorRow(row: SymbolEmbeddingRow): VectorRow {
  return {
    id: row.metadata.symbolId,
    vector: row.vector,
    metadata: {
      chunkId: row.metadata.symbolId,
      documentId: row.metadata.symbolId,
      filename: row.metadata.filePath,
      position: 0,
      text: row.metadata.text ?? "",
      embeddingModel: row.metadata.embeddingModel ?? "",
    },
  };
}

// ---- SymbolVectorStore (the read path HybridCodeSearch consumes) -----------

/**
 * The real vector half of {@link import("./hybrid-search.js").HybridCodeSearch}.
 *
 * The model filter is MANDATORY, not an optimisation: it is what makes a
 * mixed-generation store safe to query. Without it a 384-dim bge row and a
 * 768-dim gte row would be candidates for the same ranking.
 */
export function createSymbolVectorStore(deps: SymbolEmbeddingDeps = {}): SymbolVectorStore {
  const { store, model } = resolveDeps(deps);
  return {
    async search(projectId: string, queryVector: number[], k: number): Promise<VectorSearchHit[]> {
      if (k <= 0 || queryVector.length === 0) return [];
      const hits = await store.search(symbolVectorsId(projectId), queryVector, k, {
        embeddingModel: model(),
      });
      return hits.map((h) => ({
        // Only `metadata.symbolId` is read downstream (hybrid-search fuses on it
        // and hydrates the rest from Prisma), so the rest is best-effort.
        metadata: {
          symbolId: h.row.id,
          filePath: h.row.metadata.filename,
          kind: "",
          name: "",
          qualifiedName: "",
          contentHash: "",
          text: h.row.metadata.text,
          embeddingModel: h.row.metadata.embeddingModel,
        },
        score: h.score,
      }));
    },
  };
}

// ---- The embed job --------------------------------------------------------

export interface EmbedProjectSymbolsOptions extends SymbolEmbeddingDeps {
  batchSize?: number;
  onProgress?: (progress: { completed: number; total: number }) => void;
}

/** In-process guard — one symbol-embed run per project at a time, per POD. */
const running = new Set<string>();

/** True while an embed/re-index run is in flight for `projectId` IN THIS PROCESS. */
export function isEmbeddingSymbols(projectId: string): boolean {
  return running.has(projectId);
}

/**
 * PR #803 review (D3) — run `fn` under the project's REINDEX LEASE, not under a
 * second, home-grown lock.
 *
 * ## Why the advisory lock this replaces had to go
 *
 * An earlier round of this PR guarded the symbol corpus with its own
 * `pg_try_advisory_lock('symbol-embed:<projectId>')`, released by a separate
 * `$executeRaw` outside any `$transaction`. That is precisely the anti-pattern #798
 * had just finished DELETING from the document path, for a reason that applies here
 * unchanged: Prisma's `PrismaPg` adapter is a POOL and only pins a connection inside
 * `$transaction`, so acquire and release can land on different backends; the unlock
 * then returns `false` (a value that code discarded) and the lock is held until the
 * pod restarts. #798 measured eight leaked locks in eight concurrent cycles
 * (`tests/reindex-lease-postgres.integration.test.ts`).
 *
 * The wedge was WORSE here than it had been for documents: a leaked symbol lock made
 * the symbol phase of every subsequent reindex throw — from INSIDE the lease callback,
 * AFTER the document swap and retag had already committed — leaving a permanently
 * half-migrated deployment that no retry could finish.
 *
 * ## One mechanism, one key
 *
 * The key is the project's ORDINARY reindex lease (`reindex:<projectId>`), not a
 * sibling `symbol-embed:<projectId>` one. A distinct key would not compose: the
 * document reindex's phase 2 mutates the symbol corpus while holding
 * `reindex:<projectId>`, so anything that must exclude phase 2 has to contend for THAT
 * name. Two names would mean two mechanisms again, and the archive's force-take would
 * fence only one of them. So: ingest's background embed, the phase-2 symbol reindex and
 * the archive's drop all contend for — and are all fenced by — a single lease.
 *
 * The consequence, deliberately accepted: a running symbol embed now refuses a document
 * reindex with 409 (and vice versa), where before the reindex would start, mutate the
 * document index, and only then blow up in phase 2. Refusing at the door is what makes
 * the half-migration unreachable.
 */
async function withSymbolLease<T>(
  projectId: string,
  deps: SymbolEmbeddingDeps,
  fn: (fence: ReindexFence) => Promise<T>,
): Promise<T> {
  // Cheap same-pod fast path — a round-trip saved, and the ONLY guard on the SQLite
  // runtime, where the lease backend is a deliberate no-op (single writer, one process).
  if (running.has(projectId)) throw new ReindexConflictError(projectId);
  running.add(projectId);
  try {
    return await withReindexLease(projectId, fn, {
      ...(deps.leaseBackend ? { backend: deps.leaseBackend } : {}),
    });
  } finally {
    running.delete(projectId);
  }
}

/**
 * Run `fn` under the fence the CALLER already holds, or under a freshly-taken lease when
 * it holds none. Every mutating symbol entry point goes through here, so there is no path
 * that writes symbol vectors unfenced.
 */
async function withSymbolFence<T>(
  projectId: string,
  deps: SymbolEmbeddingDeps,
  fn: (fence: ReindexFence) => Promise<T>,
): Promise<T> {
  return deps.fence ? fn(deps.fence) : withSymbolLease(projectId, deps, fn);
}

/**
 * Embed every PENDING or STALE symbol of a project and write the vectors.
 *
 * Idempotent and resumable by construction, with no progress table to fall out
 * of sync: a symbol is "done" iff a vector exists for its id, tagged with the
 * active model, whose `CodeSymbolEmbedding.contentHash` still matches. A
 * SIGKILL mid-run therefore costs at most the batch in flight, because the
 * pipeline persists each batch as it completes.
 *
 * COST (METIS, ~15k symbols): batches of 64 ⇒ ~235 sidecar posts. On the
 * `values-prod` CPU allocation a full 64-text batch measures ~12–25s, so a COLD
 * build is 45–95 minutes. That is why this is a background job and never runs
 * inline inside the ingest request. An incremental refresh touches tens of
 * symbols and finishes in seconds.
 *
 * Single-writer per project, ACROSS REPLICAS, and FENCED — see {@link withSymbolLease}.
 * Throws {@link ReindexConflictError} if a run (or a document reindex, which owns the
 * same lease) is already in flight anywhere, and {@link ReindexFencedError} if the lease
 * is taken from under it mid-run (an archive force-takes it) — the latter BEFORE the next
 * batch reaches the live namespace.
 */
export async function embedProjectSymbols(
  projectId: string,
  opts: EmbedProjectSymbolsOptions = {},
): Promise<PipelineResult> {
  return withSymbolFence(projectId, opts, async (fence) => {
    const { embedService, repo } = resolveDeps(opts);
    // The fence rides into the STORE, because that is where the writes are: the pipeline
    // upserts each batch as it completes, and each of those upserts must re-prove
    // ownership. Passing it only to the outer closure would be lexical nesting, which
    // orders the writes but fences none of them — the D1/D2 defect this fixes.
    const store = createSymbolEmbeddingStore({ ...opts, fence });

    const rows = await repo.list(projectId);
    const symbols: SymbolForEmbedding[] = rows.map((r) => ({
      symbolId: r.symbolId,
      name: r.name,
      qualifiedName: r.qualifiedName,
      kind: r.kind as SymbolKind,
      filePath: r.filePath,
      // The persisted text is replayed VERBATIM — see `formatSymbolForEmbedding`.
      text: r.text,
    }));

    const pipeline = new SymbolEmbeddingPipeline(store, embedService);
    return await pipeline.run({
      projectId,
      symbols,
      batchSize: opts.batchSize ?? MAX_EMBED_TEXTS_PER_REQUEST,
      ...(opts.onProgress
        ? {
            onProgress: (p): void =>
              opts.onProgress?.({ completed: p.completed + p.skipped, total: p.total }),
          }
        : {}),
    });
  });
}

/**
 * Fire-and-forget the embed job at the end of a code-graph ingest.
 *
 * Never throws and never blocks the caller: a failure to embed must degrade
 * `search_code_symbols` to its (still functional) BM25 branch, not fail the
 * ingest that produced the symbols. The `CodeSymbolEmbedding` rows are already
 * durable at this point, so the work is not lost — the next ingest, or an
 * operator's reindex, picks it up.
 */
export function enqueueSymbolEmbeddings(projectId: string): void {
  if (running.has(projectId)) {
    log.info("symbol-embedding job already running; not enqueueing another", { projectId });
    return;
  }
  void embedProjectSymbols(projectId)
    .then((result) => {
      log.info("symbol-embedding job finished", { projectId, ...result });
    })
    .catch((err: unknown) => {
      if (err instanceof ReindexConflictError) {
        // Another replica already owns the project's lease — a symbol embed, or a
        // document reindex whose phase 2 embeds the very same rows. Expected under
        // concurrency, not a failure.
        log.info("project reindex lease held elsewhere; skipping the symbol embed", {
          projectId,
        });
        return;
      }
      if (err instanceof ReindexFencedError) {
        // An archive (or an operator's force-unlock) took the lease from under this run.
        // It aborted BEFORE writing anything further — which is the point.
        log.info("symbol-embedding job fenced mid-run; aborted before mutating", { projectId });
        return;
      }
      log.error("symbol-embedding job failed — code search stays on its BM25 branch", {
        projectId,
        error: (err as Error).message,
      });
    });
}

// ---- #787 integration: coverage, reindex, drop, retag ---------------------

export interface SymbolModelCoverage {
  totalSymbols: number;
  modelCounts: Record<string, number>;
}

export interface SymbolReindexResult {
  projectId: string;
  totalSymbols: number;
  resumedSymbols: number;
  embeddedSymbols: number;
  currentModel: string;
}

/**
 * The surface `KnowledgeService` needs from this module. Injected so the RAG
 * layer can be unit-tested without a code graph, and so the dependency points
 * one way (rag → code-graph), never back.
 */
export interface SymbolEmbeddingsPort {
  coverage(projectId: string): Promise<SymbolModelCoverage>;
  deploymentCoverage(): Promise<Map<string, Record<string, number>>>;
  /**
   * PR #803 review (D1) — `fence` is NOT optional in practice: `KnowledgeService` calls
   * this from inside its lease and MUST hand the lease over, because being CALLED from a
   * leased closure fences nothing. It is typed optional only so a caller that holds no
   * lease (a script, a test) gets one taken for it rather than an unfenced write.
   */
  reindexProject(
    projectId: string,
    opts?: { batchSize?: number; fresh?: boolean },
    fence?: ReindexFence,
  ): Promise<SymbolReindexResult>;
  dropProject(projectId: string, fence?: ReindexFence): Promise<void>;
  retagToActiveModel(): Promise<number>;
  /**
   * Is a symbol-embed run in flight IN THIS PROCESS? The lease refuses a concurrent
   * reindex across replicas; this is the SQLite/dev answer to the same question, and
   * `KnowledgeService.reindexProject` asks it AT THE DOOR — before it mutates the
   * document index — so a busy symbol corpus can never produce a half-migrated project.
   */
  isBusy(projectId: string): boolean;
}

/** Per-model symbol counts for one project. */
export async function symbolCoverage(projectId: string): Promise<SymbolModelCoverage> {
  const grouped = await prisma.codeSymbolEmbedding.groupBy({
    by: ["embeddingModel"],
    where: { projectId },
    _count: { _all: true },
  });
  const modelCounts: Record<string, number> = {};
  let totalSymbols = 0;
  for (const g of grouped) {
    modelCounts[g.embeddingModel] = g._count._all;
    totalSymbols += g._count._all;
  }
  return { totalSymbols, modelCounts };
}

/** Per-model symbol counts for EVERY project, in one query (#787 status). */
export async function symbolDeploymentCoverage(): Promise<Map<string, Record<string, number>>> {
  const grouped = await prisma.codeSymbolEmbedding.groupBy({
    by: ["projectId", "embeddingModel"],
    _count: { _all: true },
  });
  const byProject = new Map<string, Record<string, number>>();
  for (const g of grouped) {
    const counts = byProject.get(g.projectId) ?? {};
    counts[g.embeddingModel] = (counts[g.embeddingModel] ?? 0) + g._count._all;
    byProject.set(g.projectId, counts);
  }
  return byProject;
}

/**
 * Issue #787 phase 2 — re-embed a project's symbols at the active model.
 *
 * Copies the document reindex's shape exactly (shadow table → embed every batch
 * → atomic `swapTable` → reconcile Prisma tags), because the alternative is a
 * second, subtly-different migration mechanism that would drift from the first.
 * The LIVE symbol vectors keep serving the old generation for the whole embed
 * loop; the shadow IS the resume checkpoint.
 *
 * The persisted `CodeSymbolEmbedding.text` is what makes this possible with no
 * repo checkout.
 *
 * Runs under the project's reindex FENCE (PR #803 review, D1): the caller's, when it
 * already holds the lease (the document reindex's phase 2), otherwise one taken here.
 * Every mutation below re-proves that fence at the instant it mutates.
 */
export async function reindexProjectSymbols(
  projectId: string,
  opts: { batchSize?: number; fresh?: boolean } & SymbolEmbeddingDeps = {},
): Promise<SymbolReindexResult> {
  return withSymbolFence(projectId, opts, (fence) => runSymbolReindex(projectId, opts, fence));
}

async function runSymbolReindex(
  projectId: string,
  opts: { batchSize?: number; fresh?: boolean } & SymbolEmbeddingDeps,
  fence: ReindexFence,
): Promise<SymbolReindexResult> {
  const { store, embedService, model } = resolveDeps(opts);
  const currentModel = model();
  const batchSize = Math.max(1, Math.min(opts.batchSize ?? MAX_EMBED_TEXTS_PER_REQUEST, 1000));
  const liveNs = symbolVectorsId(projectId);
  const shadowNs = symbolReindexShadowId(projectId);

  const rows = await prisma.codeSymbolEmbedding.findMany({
    where: { projectId },
    select: { symbolId: true, text: true, symbol: { select: { filePath: true } } },
    orderBy: { symbolId: "asc" },
  });

  if (rows.length === 0) {
    await store.dropTable(shadowNs).catch(() => {});
    return {
      projectId,
      totalSymbols: 0,
      resumedSymbols: 0,
      embeddedSymbols: 0,
      currentModel,
    };
  }

  const snapshot = new Set(rows.map((r) => r.symbolId));
  const resumed = await resumableShadowIds(store, shadowNs, currentModel, snapshot, opts.fresh);
  await store.ensureTable(shadowNs);

  const pending = rows.filter((r) => !resumed.has(r.symbolId));
  let embedded = 0;
  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    const { vectors, model: usedModel } = await embedService.embed(batch.map((r) => r.text));
    if (vectors.length !== batch.length) {
      throw new Error(
        `symbol reindex embedder returned ${vectors.length} vectors for ${batch.length} symbols`,
      );
    }
    const vrows: VectorRow[] = batch.map((r, j) => ({
      id: r.symbolId,
      vector: vectors[j],
      metadata: {
        chunkId: r.symbolId,
        documentId: r.symbolId,
        filename: r.symbol.filePath,
        position: 0,
        text: r.text,
        embeddingModel: usedModel,
      },
    }));
    // THE FENCE, per batch, BEFORE the upsert — the exact shape the document reindex
    // uses (`knowledge-service.ts`, "Issue #798 — THE FENCE, per batch"). A run whose
    // lease was stolen or force-taken (project archive) must not even RECREATE the
    // shadow it was told to abandon. Zero rows renewed ⇒ fenced ⇒ abort before writing.
    if (!(await fence.renew())) throw new ReindexFencedError(projectId, fence.holder);
    await store.upsert(shadowNs, vrows);
    embedded += batch.length;
  }

  // THE SECOND FENCE, at the cut-over, and the one that actually closes D2. `assertHeld`
  // fails fast if we were fenced during the last batch; handing the fence to `swapTable`
  // as its `SwapGuard` re-checks it a THIRD time inside the store's own swap transaction
  // (pgvector), where the check and the cut-over commit together. Without the guard
  // argument `swapTable` "behaves exactly as it did before #798" (`vector-store.ts`) — so
  // an archived project's symbol table would be RESURRECTED from the shadow of a run that
  // had already been fenced. Heartbeat suspended across the swap for the reason
  // `ReindexLease.withHeartbeatPaused` documents (the guard's row lock would otherwise
  // park a pooled connection per tick).
  await fence.assertHeld();
  await fence.withHeartbeatPaused(() => store.swapTable(liveNs, shadowNs, fence));

  // The retag mutates the DURABLE model tags — i.e. it is what makes `coverage()` and
  // `needsReindex` report this generation as migrated. Re-prove the fence once more before
  // committing that claim: a fenced run that retagged would leave a green,
  // "fully-migrated" deployment describing a swap that never happened.
  if (!(await fence.renew())) throw new ReindexFencedError(projectId, fence.holder);

  // Tag EXACTLY the snapshot, never the project (PR #803 review, M2).
  //
  // `where: { projectId }` would also catch every row a concurrent ingest inserted
  // AFTER the snapshot was taken — rows this run never embedded and whose vectors
  // the swap therefore did not write. They would come out tagged at the active model
  // with nothing behind them: the same false-green as B3, arrived at by a race
  // rather than by a query bug. Chunked because `IN` over a 15k-symbol project is a
  // statement no database should be asked to plan.
  const snapshotIds = [...snapshot];
  for (let i = 0; i < snapshotIds.length; i += RETAG_CHUNK) {
    await prisma.codeSymbolEmbedding.updateMany({
      where: { projectId, symbolId: { in: snapshotIds.slice(i, i + RETAG_CHUNK) } },
      data: { embeddingModel: currentModel },
    });
  }

  log.info("project symbol vectors reindexed", {
    projectId,
    totalSymbols: rows.length,
    resumedSymbols: resumed.size,
    embeddedSymbols: embedded,
    currentModel,
  });

  return {
    projectId,
    totalSymbols: rows.length,
    resumedSymbols: resumed.size,
    embeddedSymbols: embedded,
    currentModel,
  };
}

/**
 * Which of a surviving shadow's rows may be RESUMED. Same three rules as the
 * document reindex: `fresh` drops everything; a shadow carrying ANOTHER model's
 * rows is an abandoned migration and is dropped whole (resuming it would build
 * one table out of two vector spaces); rows for symbols that no longer exist are
 * deleted from the shadow and the rest is kept.
 */
async function resumableShadowIds(
  store: VectorStore,
  shadowNs: string,
  currentModel: string,
  snapshot: Set<string>,
  fresh?: boolean,
): Promise<Set<string>> {
  if (fresh) {
    await store.dropTable(shadowNs).catch(() => {});
    return new Set();
  }
  const refs = await store.listChunkRefs(shadowNs).catch(() => []);
  if (refs.length === 0) return new Set();

  if (refs.some((r) => r.embeddingModel !== currentModel)) {
    log.warn("symbol reindex shadow belongs to another model generation — discarding it", {
      shadowNs,
      currentModel,
    });
    await store.dropTable(shadowNs).catch(() => {});
    return new Set();
  }

  const orphans = refs.filter((r) => !snapshot.has(r.chunkId)).map((r) => r.chunkId);
  if (orphans.length > 0) {
    await store.deleteByChunkIds(shadowNs, orphans);
  }
  return new Set(refs.filter((r) => snapshot.has(r.chunkId)).map((r) => r.chunkId));
}

/**
 * Drop a project's symbol vectors (live + shadow). Wired to project archive.
 *
 * ## PR #803 review (D2) — what actually closes the archive-vs-embed race
 *
 * NOT the drop itself, and NOT the fact that `KnowledgeService.dropProject` calls it from
 * inside its leased closure. It is closed by the two things the fence does to the OTHER
 * run: the archive FORCE-TAKES the project's lease (revoking the fencing token of any
 * in-flight embed or phase-2 reindex), and those runs re-prove that token before every
 * write — per batch, at the cut-over, and inside `swapTable`'s own transaction. So a
 * fenced run cannot recreate the live symbol table after we drop it, and cannot retag
 * Prisma to claim it did.
 *
 * `fence` is therefore an assertion, not the mechanism: it confirms WE still hold the
 * lease we force-took. It is optional because `KnowledgeService.dropProject` has a
 * deliberate fail-SAFE fallback that drops UNFENCED when the lease table itself is
 * unavailable — an archive must never be un-completable.
 */
export async function dropProjectSymbols(
  projectId: string,
  deps: SymbolEmbeddingDeps = {},
  fence?: ReindexFence,
): Promise<void> {
  const { store } = resolveDeps(deps);
  if (fence) await fence.assertHeld();
  await store.dropTable(symbolVectorsId(projectId)).catch(() => {});
  await store.dropTable(symbolReindexShadowId(projectId)).catch(() => {});
}

/**
 * Re-label every EMBEDDED symbol row with the active model WITHOUT re-embedding
 * (#787 rollback: the vectors on disk are fine, only their tag is stale).
 *
 * PENDING rows are EXCLUDED, and that exclusion is the whole safety property (PR
 * #803 review, B3). The document-shaped retag is `{ not: activeModel }`, which also
 * matches `""` — sweeping PENDING symbols into the active model would claim a vector
 * that was never written, `coverage()` would count them as migrated, `needsReindex`
 * would go false, and `pnpm embed-migrate status` would report a green, fully-migrated
 * deployment over symbols that have no vector at all. That is precisely the
 * false-green this module's symbol accounting exists to prevent, so a retag must
 * leave PENDING exactly where it is: visible, and still owed an embed.
 */
export async function retagSymbolsToActiveModel(deps: SymbolEmbeddingDeps = {}): Promise<number> {
  const { model } = resolveDeps(deps);
  const activeModel = model();
  const { count } = await prisma.codeSymbolEmbedding.updateMany({
    where: { embeddingModel: { notIn: [activeModel, PENDING_MODEL] } },
    data: { embeddingModel: activeModel },
  });
  return count;
}

/** The default {@link SymbolEmbeddingsPort} — the real Prisma + VectorStore one. */
export function getSymbolEmbeddingsPort(): SymbolEmbeddingsPort {
  return {
    coverage: symbolCoverage,
    deploymentCoverage: symbolDeploymentCoverage,
    reindexProject: (projectId, opts, fence) =>
      reindexProjectSymbols(projectId, { ...(opts ?? {}), ...(fence ? { fence } : {}) }),
    dropProject: (projectId, fence) => dropProjectSymbols(projectId, {}, fence),
    retagToActiveModel: () => retagSymbolsToActiveModel(),
    isBusy: isEmbeddingSymbols,
  };
}
