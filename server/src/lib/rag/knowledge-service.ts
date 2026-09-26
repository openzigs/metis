/**
 * Knowledge service (Phase 5 / issue #43).
 *
 * Orchestrates the full RAG pipeline:
 *
 *   ingestDocument → parse → chunk → embed → upsert vectors → persist Prisma rows
 *   search        → embed query → vector store top-k → join Prisma rows
 *   deleteDocument → drop vectors → cascade Prisma rows
 *
 * The service is dependency-injected (storage / embedder / vector store) so
 * tests can substitute deterministic fakes without touching the real
 * filesystem or model loader.
 */
import { randomUUID } from "node:crypto";
import {
  type CoverageWarning,
  DEFAULT_RAG_CHUNK_OVERLAP,
  DEFAULT_RAG_CHUNK_SIZE,
  DEFAULT_RETRIEVAL_MODE,
  DEFAULT_RETRIEVE_K,
  type RetrievalMode,
  type RetrievedChunk,
} from "@metis/shared";
import { prisma } from "../prisma.js";
import { withVectorSql, type ProjectVectorWrite } from "./project-vector-write.js";
import {
  chunkMarkdown,
  chunkerIdentity,
  classifyChunkerIdentity,
  type ChunkOptions,
  resolveChunkParams,
} from "./chunker.js";
import { Embedder, getEmbedder } from "./embedder.js";
import {
  forceReleaseReindexLease,
  readReindexLease,
  ReindexConflictError,
  ReindexFencedError,
  type ReindexLease,
  type ReindexLeaseBackend,
  type ReindexLeaseInfo,
  withReindexLease,
} from "./reindex-lease.js";
import {
  getVectorStore,
  type SearchFilter,
  type StoredChunkRef,
  type VectorRow,
  type VectorStore,
} from "./vector-store.js";
import { CONTENT_TYPE_MISMATCH, parseDocument } from "../documents/parsers.js";
import { embedInBoundedBatches } from "./embed-batched.js";
import { getDocumentStorage, type StorageBackend } from "../documents/storage.js";
import { onArchive } from "../projects/project-service.js";
import { createChildLogger } from "../logger.js";
import { BM25Index, getBM25Index, reciprocalRankFusion } from "./bm25-index.js";
import { getReranker, type Reranker } from "./reranker.js";
import { type AclActor, filterAccessible, parseAclSubjects } from "./acl.js";
import { assertEvidencePolicy, type EvidencePolicy } from "../docs-gen/evidence-policy.js";
import { filterPrimaryEvidence } from "../docs-gen/evidence-filter.js";
import { writeQuarantine, shouldAutoApprove, approveDocument } from "./quarantine.js";
import { audit } from "../audit/audit-service.js";
import {
  getSymbolEmbeddingsPort,
  type SymbolEmbeddingsPort,
  type SymbolReindexResult,
} from "../code-graph/symbol-embedding-service.js";

const log = createChildLogger("knowledge");

/** Missing width is supported only for legacy structural doubles. Shipped stores
 * always report actual persisted width, including 0 for missing vector evidence. */
function matchesEmbeddingGeneration(
  ref: StoredChunkRef,
  model: string,
  dimension: number,
): boolean {
  return (
    ref.embeddingModel === model &&
    (ref.dimension === undefined ||
      (Number.isInteger(ref.dimension) && ref.dimension > 0 && ref.dimension === dimension))
  );
}

/**
 * Internal upper clamp for {@link KnowledgeService.search}'s `k`. This is the
 * INTERNAL retrieval ceiling — distinct from `MAX_RETRIEVE_K` (the public
 * search-tool/API input cap validated on user-supplied `k`). Internal callers
 * (e.g. per-section doc-grounding, which passes `DEFAULT_GROUNDING_K`) may ask
 * for more chunks than the public tool exposes; this keeps the round-trip
 * bounded while honoring those larger internal requests.
 *
 * MUST stay ≥ `DEFAULT_GROUNDING_K`/`MAX_GROUNDING_K`
 * (`docs-gen/grounding/grounding-retrieval.ts`): if grounding asks for 80 but
 * this clamps to less, 80 is silently truncated and the recall lever is a no-op.
 */
export const MAX_SEARCH_K = 80;

export interface KnowledgeServiceDeps {
  embedder?: Embedder;
  vectorStore?: VectorStore;
  storage?: StorageBackend;
  chunkOptions?: ChunkOptions;
  /**
   * Optional realtime emitter. Wired to Socket.IO in production so the UI can
   * reflect ingestion progress without polling. Tests pass a spy.
   */
  emit?: (event: KnowledgeEvent) => void;
  /**
   * BM25 sparse index used by hybrid retrieval (issue #131). Defaults to the
   * process-wide singleton; tests can pass a fresh instance for isolation.
   */
  bm25?: BM25Index;
  /**
   * Optional cross-encoder reranker (issue #131). Defaults to the global
   * singleton, which is a no-op unless `RAG_RERANK=1` is set.
   */
  reranker?: Reranker;
  /**
   * Epic #780 / Issue #797 — the code-symbol embedding side of a model
   * migration. A model flip must re-embed symbol vectors too, not just document
   * chunks; without this, `pnpm embed-migrate status` would report a fully
   * migrated deployment while every symbol vector was still on the old model.
   *
   * Injected (rather than imported and called directly) so the RAG layer stays
   * unit-testable without a code graph, and so the dependency runs one way only.
   */
  symbolEmbeddings?: SymbolEmbeddingsPort;
  /**
   * Issue #798 — the cross-process reindex-lease backend. Defaults to the
   * env-resolved one (Postgres when `DATABASE_URL` is Postgres, a no-op otherwise).
   * Tests inject the in-memory fake; two services sharing ONE of those model two pods
   * sharing one database.
   */
  reindexLeaseBackend?: ReindexLeaseBackend;
}

export type KnowledgeEvent = {
  type: "document:status";
  projectId: string;
  documentId: string;
  status: "pending" | "queued" | "processing" | "ready" | "failed";
  chunkCount?: number;
  errorMessage?: string | null;
  /** Issue #133 — surfaced for queued + retrying transitions. */
  attempt?: number;
};

export interface IngestResult {
  documentId: string;
  status: "ready" | "failed" | "pending";
  chunkCount: number;
  errorMessage?: string;
}

export interface SearchOptions {
  k?: number;
  /** #1353 — docs-generation only; live SQL scope/primary policy before rerank. */
  evidencePolicy?: EvidencePolicy;
  documentIds?: string[];
  /**
   * If true, do NOT filter results to the current embedding model. Useful for
   * diagnostics. Default false — mismatched-model chunks are silently dropped
   * from `hits` but reported via `coverageWarning`.
   */
  includeAllModels?: boolean;
  /**
   * Retrieval mode (issue #131). Defaults to `hybrid`.
   *   - `dense`  — vector similarity only.
   *   - `hybrid` — dense + BM25, merged via reciprocal rank fusion.
   *
   * The cross-encoder rerank is a separate post-step gated on
   * `RAG_RERANK=1` regardless of mode.
   */
  mode?: RetrievalMode;
  /**
   * Override the candidate pool size fed into RRF + rerank. Defaults to
   * `max(k * 4, 20)` so we have enough material for fusion to matter while
   * still keeping the dense + sparse round-trips bounded.
   */
  fusionPoolSize?: number;
  /**
   * Epic #157 — when present, ACL filtering runs on the candidate pool BEFORE
   * rerank. Chunks with non-empty `aclSubjects` lists are dropped unless the
   * actor matches one of them. The `admin` role bypasses ACL entirely (still
   * audit-logged at the call site).
   */
  actor?: AclActor;
  /**
   * Epic #157 — when set, denied chunks are reported back via
   * `aclMismatch` for audit logging. Off by default so existing tests don't
   * have to assert on the new field.
   */
  reportAclMismatch?: boolean;
}

export interface ReindexProgress {
  processed: number;
  total: number;
}

export interface ReindexResult {
  projectId: string;
  totalChunks: number;
  reindexedChunks: number;
  previousModels: string[];
  currentModel: string;
  currentDimension: number;
  durationMs: number;
  /**
   * Issue #787 — chunks this run did NOT have to embed because a previous,
   * interrupted run had already written them into the shadow. `0` on a clean run.
   */
  resumedChunks: number;
  /** Issue #787 — chunks this run actually sent to the embedder. */
  embeddedChunks: number;
  /**
   * Issue #797 — the CODE-SYMBOL half of the reindex (phase 2), or `null` when
   * the project has no symbol embeddings at all.
   *
   * A model flip has to move both corpora. Documents are swapped first (phase 1)
   * because they are the older, larger and more visible index; symbols follow in
   * their own `<projectId>__symbols` namespace with the same shadow → embed →
   * atomic-swap → retag sequence.
   */
  symbols: SymbolReindexResult | null;
}

export interface ReindexOptions {
  batchSize?: number;
  onProgress?: (p: ReindexProgress) => void;
  /**
   * Issue #787 — discard any surviving shadow and re-embed the whole project from
   * scratch. Default `false`: an interrupted reindex RESUMES from its shadow.
   *
   * The escape hatch exists for the case the resume logic deliberately cannot
   * detect — a shadow whose rows carry the right model tag but whose vectors the
   * operator has reason to distrust (e.g. built while a hash fallback was
   * silently active, before #783 made that loud).
   */
  fresh?: boolean;
}

/**
 * Issue #787 — the shadow-reindex state of one project, as an operator sees it.
 *
 * `inProgress` is process-local (the in-flight guard); `shadowChunks` is the
 * DURABLE bit — a non-zero count with no reindex running means a previous run was
 * interrupted (pod eviction, OOM kill, deploy) and left a resumable checkpoint.
 */
export interface ReindexShadowState {
  projectId: string;
  inProgress: boolean;
  shadowChunks: number;
  shadowModels: string[];
  /** True when the shadow's rows were built by the model that is active NOW. */
  resumable: boolean;
  /**
   * Issue #798 — WHO holds the cross-process reindex lease, when they last renewed
   * it, and whether it has expired. `null` when nobody holds one (and always `null`
   * on a non-Postgres runtime, which has no cross-process lease). An EXPIRED lease is
   * the fingerprint of a run that died without releasing — the state that used to
   * mean "restart the pod" and now means "it will be stolen by the next attempt, or
   * `embeddings:migrate unlock` it".
   */
  lease: ReindexLeaseInfo | null;
}

/** Issue #787 — deployment-wide, per-project embedding-model coverage. */
export interface DeploymentCoverageReport {
  currentModel: string;
  currentDimension: number;
  totalChunks: number;
  /** Chunk counts by model across EVERY project (the mixed-generation picture). */
  modelCounts: Record<string, number>;
  projects: Array<{
    projectId: string;
    totalChunks: number;
    matchingChunks: number;
    modelCounts: Record<string, number>;
    /** Issue #797 — the project's code-symbol embeddings ("" = pending, no vector yet). */
    totalSymbols: number;
    matchingSymbols: number;
    symbolModelCounts: Record<string, number>;
    needsReindex: boolean;
    /** Issue #1182 — chunker generations here ("" = untagged, provenance unrecorded). */
    chunkerCounts: Record<string, number>;
    matchingChunkerChunks: number;
    needsReingest: boolean;
  }>;
  /** Total symbol embeddings across every project (#797). */
  totalSymbols: number;
  /** Symbol counts by model across EVERY project (#797). */
  symbolModelCounts: Record<string, number>;
  /** Projects with at least one chunk OR symbol embedded by a model other than the active one. */
  projectsNeedingReindex: number;
  /**
   * Issue #1182 — the chunker generation the ACTIVE configuration would produce
   * (`doc:v2:2048/256` — producer, version, effective parameters), and the
   * deployment-wide split across generations.
   */
  currentChunkerIdentity: string;
  chunkerCounts: Record<string, number>;
  /**
   * Projects holding at least one chunk cut by another chunker generation. Kept
   * apart from {@link projectsNeedingReindex} because the remedy differs: these
   * need a RE-INGEST (`chunkMarkdown` runs only at ingest), and a reindex would
   * re-embed the same gapped text and report success.
   */
  projectsNeedingReingest: number;
}

/**
 * Issue #941 — thrown when a reindex is requested for a project that already has one
 * in flight (the admin route maps it to HTTP 409). Issue #798 moved the class into
 * `reindex-lease.ts` (where the cross-process guard now lives) and re-exports it from
 * here, so every existing import and `instanceof` is unchanged.
 */
export { ReindexConflictError, ReindexFencedError } from "./reindex-lease.js";

/** Issue #941 — name of the transient shadow table a reindex builds into. */
export function reindexShadowId(projectId: string): string {
  return `${projectId}__reindex`;
}

export interface CoverageReport {
  totalChunks: number;
  modelCounts: Record<string, number>;
  currentModel: string;
  currentDimension: number;
  matchingChunks: number;
  mismatchedModels: string[];
  /**
   * Issue #797 — code-symbol embedding counts, reported ALONGSIDE the document
   * chunks rather than merged into them. They are different corpora, they live in
   * different namespaces, and an operator needs to see which of the two is behind.
   * `""` in `symbolModelCounts` means PENDING — the row exists, the vector does not.
   */
  totalSymbols: number;
  symbolModelCounts: Record<string, number>;
  matchingSymbols: number;
  /** True when any chunk OR symbol was embedded by a model other than the active one. */
  needsReindex: boolean;
  /**
   * Issue #1182 — the CHUNKER half, reported separately from the model half and
   * deliberately NOT folded into {@link needsReindex}.
   *
   * The two drifts have different remedies and merging them would prescribe the
   * wrong one. A model drift is repaired by `reindexProject`, which re-embeds
   * stored chunk text. A chunker drift is not: re-embedding leaves every boundary
   * where it was, so `reindex` would run for hours, report success, and change
   * nothing. Chunker drift is repaired only by RE-INGESTING the document, which
   * is the one path that runs `chunkMarkdown` again.
   *
   * `""` in {@link chunkerCounts} means the row carries no tag: it was written
   * before #1182 and its provenance is UNRECORDED. It may be the pre-#1178
   * generation whose chunks did not tile; it may equally be a generated-doc
   * chunk. Counted as outstanding either way — see ADR 0006.
   */
  currentChunkerIdentity: string;
  chunkerCounts: Record<string, number>;
  matchingChunkerChunks: number;
  /** True when any chunk was cut by a chunker generation other than the active one. */
  needsReingest: boolean;
}

export interface SearchResult {
  hits: RetrievedChunk[];
  /**
   * Present when the project has chunks from a different model than the
   * currently-configured embedder. Per R-D1 the search uses chunks matching
   * the current model; the warning surfaces the partial coverage.
   */
  coverageWarning?: CoverageWarning;
  /** The retrieval mode that actually ran (echoed back for telemetry). */
  mode: RetrievalMode;
  /** True when the cross-encoder rerank ran. */
  reranked?: boolean;
  /**
   * Epic #157 — chunk ids dropped because the requesting actor lacked an
   * ACL match. Populated only when the caller passed `reportAclMismatch`.
   */
  aclMismatch?: string[];
}

export class KnowledgeService {
  private readonly embedder: Embedder;
  private readonly store: VectorStore;
  private readonly storage: StorageBackend;
  private readonly chunkOptions: ChunkOptions;
  private readonly emit: (event: KnowledgeEvent) => void;
  private readonly bm25: BM25Index;
  private readonly reranker: Reranker;
  /** Issue #941 — per-project reindex guard; a project id present here has a reindex in flight. */
  private readonly reindexing = new Set<string>();
  /** Issue #797 — the symbol-vector half of coverage / reindex / drop / retag. */
  private readonly symbols: SymbolEmbeddingsPort;
  /**
   * Issue #798 — the CROSS-process guard. `undefined` means "resolve from env at the
   * call site" (the production path); tests inject a shared in-memory fake.
   */
  private readonly leaseBackend: ReindexLeaseBackend | undefined;

  constructor(deps: KnowledgeServiceDeps = {}) {
    this.leaseBackend = deps.reindexLeaseBackend;
    this.embedder = deps.embedder ?? getEmbedder();
    this.store = deps.vectorStore ?? getVectorStore();
    this.storage = deps.storage ?? getDocumentStorage();
    this.chunkOptions = deps.chunkOptions ?? resolveEnvChunkOptions();
    this.emit = deps.emit ?? noopEmit;
    this.bm25 = deps.bm25 ?? getBM25Index();
    this.reranker = deps.reranker ?? getReranker();
    this.symbols = deps.symbolEmbeddings ?? getSymbolEmbeddingsPort();
  }

  /**
   * Ingest a document that has already been written to storage and persisted
   * as a `pending` Prisma row. Idempotent: re-ingesting the same documentId
   * deletes prior chunks/vectors first.
   *
   * Epic #157 — chunks are computed + embedded and then routed to the
   * quarantine table by default. Auto-approve flags (per-doc or per-project)
   * cause an immediate transition to `indexed`.
   */
  async ingestDocument(documentId: string): Promise<IngestResult> {
    const doc = await prisma.document.findFirst({
      where: { id: documentId, deletedAt: null },
    });
    if (!doc) throw new Error(`Document ${documentId} not found`);

    this.emitStatus(doc.projectId, documentId, "processing");
    const ingestGeneration = randomUUID();
    const obsolete = await prisma.$transaction(async (tx) => {
      await tx.document.update({
        where: { id: documentId },
        data: { indexState: "pending", status: "processing", errorMessage: null },
      });
      await tx.quarantineChunk.updateMany({
        where: { documentId, ord: { in: [-2, -3, -4] } },
        data: { ord: -1 },
      });
      const old = await tx.knowledgeChunk.findMany({ where: { documentId }, select: { id: true } });
      await tx.quarantineChunk.createMany({
        data: [
          {
            id: ingestGeneration,
            documentId,
            projectId: doc.projectId,
            ord: -4,
            text: "",
            embedding: "[]",
            metadata: JSON.stringify({ approvalChunkIds: old.map((row) => row.id) }),
          },
        ],
      });
      await tx.knowledgeChunk.deleteMany({ where: { documentId } });
      await tx.quarantineChunk.deleteMany({ where: { documentId, ord: { gte: 0 } } });
      return old.map((row) => row.id);
    });
    // Never document-wide deletion: another generation may write while IO waits.
    await this.store.deleteByChunkIds(doc.projectId, obsolete);
    await this.bm25.removeChunkIds(doc.projectId, documentId, obsolete);

    let buffer: Buffer;
    try {
      buffer = await this.storage.read(doc.storagePath);
    } catch (err) {
      return this.markFailed(
        doc.projectId,
        documentId,
        `storage read failed: ${(err as Error).message}`,
        ingestGeneration,
      );
    }

    const parsed = await parseDocument({
      buffer,
      mimeType: doc.mimeType,
      filename: doc.filename,
    });
    if (!parsed.ok) {
      // Leave document in `pending` so a follow-up ingest can pick it up once the parser
      // becomes available. `MIME_UNSUPPORTED` and `CONTENT_TYPE_MISMATCH` are fatal:
      // neither can change on a retry, so leaving them `pending` would re-read and
      // re-refuse the same bytes on every ingest sweep (#1279).
      const fatal =
        parsed.reason === "MIME_UNSUPPORTED" || parsed.reason.startsWith(CONTENT_TYPE_MISMATCH);
      const status = fatal ? "failed" : "pending";
      await prisma.document.update({
        where: { id: documentId },
        data: { status, errorMessage: parsed.reason, chunkCount: 0 },
      });
      this.emitStatus(doc.projectId, documentId, status, 0, parsed.reason);
      return { documentId, status, chunkCount: 0, errorMessage: parsed.reason };
    }

    const chunks = chunkMarkdown(parsed.text, this.chunkOptions);
    const docAcl = parseAclSubjects(doc.aclSubjects);
    if (chunks.length === 0) {
      await writeQuarantine({
        documentId,
        projectId: doc.projectId,
        filename: doc.filename,
        ingestGeneration,
        chunks: [],
        embeddingModel: "empty",
        aclSubjects: docAcl,
      });
      await approveDocument(
        documentId,
        { id: doc.uploadedById },
        { vectorStore: this.store, bm25: this.bm25 },
      );
      this.emitStatus(doc.projectId, documentId, "ready", 0);
      return { documentId, status: "ready", chunkCount: 0 };
    }

    let embeddings;
    try {
      // #182 — bounded batches (the #189 bulk path): a repository file up to
      // REPO_SOURCE_MAX_FILE_BYTES is hundreds of chunks, never one embed call.
      embeddings = await embedInBoundedBatches(
        this.embedder,
        chunks.map((c) => c.text),
      );
    } catch (err) {
      return this.markFailed(
        doc.projectId,
        documentId,
        `embedding failed: ${(err as Error).message}`,
        ingestGeneration,
      );
    }
    if (embeddings.vectors.length !== chunks.length) {
      return this.markFailed(
        doc.projectId,
        documentId,
        `embedder returned ${embeddings.vectors.length} vectors for ${chunks.length} chunks`,
        ingestGeneration,
      );
    }

    // Park chunks in quarantine. The auto-approve policy may immediately
    // graduate them to `indexed` via `approveDocument`.
    await writeQuarantine({
      documentId,
      ingestGeneration,
      projectId: doc.projectId,
      filename: doc.filename,
      chunks: chunks.map((c, i) => ({
        ord: c.position,
        text: c.text,
        md5: c.md5,
        embedding: embeddings.vectors[i],
        headings: c.headings,
      })),
      // #792 — persist the composite IDENTITY (model|pooling|dtype, or bare model
      // at built-in defaults), not the model id, so a later pooling/dtype flip is
      // seen as a coverage mismatch. `identity` is absent for backends where the
      // model id IS the identity (hash stub, cloud) — fall back to it.
      embeddingModel: embeddings.identity ?? embeddings.model,
      // #1182 — the CHUNKER generation, which is a different question from the
      // embedding model: this says how the text was CUT, not how it was
      // vectorised. Ingest is the only place in the server that runs
      // `chunkMarkdown`, so it is the only place that can honestly answer it —
      // `reindexProject` re-embeds stored chunk TEXT and never re-chunks, which is
      // exactly why chunker drift needs a re-ingest rather than a reindex.
      chunkerIdentity: chunkerIdentity(this.chunkOptions),
      aclSubjects: docAcl,
    });

    const autoApprove = await shouldAutoApprove(documentId);
    if (autoApprove) {
      try {
        const result = await approveDocument(
          documentId,
          { id: doc.uploadedById },
          { vectorStore: this.store, bm25: this.bm25 },
        );
        this.emitStatus(doc.projectId, documentId, "ready", result.chunkCount);
        log.info("document auto-approved", {
          projectId: doc.projectId,
          documentId,
          chunkCount: result.chunkCount,
        });
        return { documentId, status: "ready", chunkCount: result.chunkCount };
      } catch (err) {
        return this.markFailed(
          doc.projectId,
          documentId,
          `auto-approve failed: ${(err as Error).message}`,
          ingestGeneration,
        );
      }
    }

    // Quarantined — surface a non-failure status so the UI can show a
    // pending-review badge.
    await prisma.document.update({
      where: { id: documentId },
      data: {
        status: "ready",
      },
    });
    this.emitStatus(doc.projectId, documentId, "ready", chunks.length);
    log.info("document quarantined", {
      projectId: doc.projectId,
      documentId,
      chunkCount: chunks.length,
    });
    return { documentId, status: "ready", chunkCount: chunks.length };
  }

  /**
   * Vector search over a project's chunks.
   * Returns top-k hits with source attribution and an optional coverage
   * warning when chunks were embedded with a different model than the current.
   */
  async search(projectId: string, query: string, opts: SearchOptions = {}): Promise<SearchResult> {
    if (opts.evidencePolicy) assertEvidencePolicy(opts.evidencePolicy, projectId);
    const k = clamp(opts.k ?? DEFAULT_RETRIEVE_K, 1, MAX_SEARCH_K);
    const mode: RetrievalMode = opts.mode ?? DEFAULT_RETRIEVAL_MODE;
    if (!query || query.trim().length === 0) return { hits: [], mode };
    const queryEmbed = await this.embedder.embed([query]);
    const vectors = queryEmbed.vectors;
    // #792 — the identity the query was ACTUALLY embedded with. For the sidecar
    // this is the value the sidecar echoed, so query and corpus are compared in
    // the SAME identity space even when the server's env disagrees with the
    // sidecar's. Corpus rows with a different pooling/dtype are filtered out and
    // surfaced via the coverage warning, exactly as a model mismatch already was.
    const currentIdentity = queryEmbed.identity ?? this.embedder.model;

    const filter: SearchFilter = {};
    if (!opts.includeAllModels) filter.embeddingModel = currentIdentity;
    if (opts.documentIds && opts.documentIds.length > 0) filter.documentIds = opts.documentIds;

    // Pull a deeper candidate pool for fusion + rerank, then trim to k.
    const poolSize = clamp(opts.fusionPoolSize ?? Math.max(k * 4, 20), k, 200);
    const denseHits = await this.store.search(projectId, vectors[0], poolSize, filter);

    // Build a chunkId → metadata map so we can hydrate the final hits in one
    // place regardless of which retrieval source ranked them.
    const meta = new Map<
      string,
      {
        chunkId: string;
        documentId: string;
        filename: string;
        position: number;
        text: string;
        score: number;
        embeddingModel: string;
      }
    >();
    for (const h of denseHits) {
      meta.set(h.row.metadata.chunkId, {
        chunkId: h.row.metadata.chunkId,
        documentId: h.row.metadata.documentId,
        filename: h.row.metadata.filename,
        position: h.row.metadata.position,
        text: h.row.metadata.text,
        score: h.score,
        embeddingModel: h.row.metadata.embeddingModel,
      });
    }

    let ordered: { chunkId: string; score: number }[];
    if (mode === "dense") {
      ordered = denseHits.map((h) => ({ chunkId: h.row.metadata.chunkId, score: h.score }));
    } else {
      const sparseHits = await this.runBM25Safe(projectId, query, poolSize);
      // Hydrate any sparse-only hits from Prisma so RRF still produces them.
      const missing = sparseHits.filter((h) => !meta.has(h.chunkId)).map((h) => h.chunkId);
      if (missing.length > 0) {
        const rows = await prisma.knowledgeChunk.findMany({
          where: { id: { in: missing }, projectId },
          select: {
            id: true,
            documentId: true,
            position: true,
            text: true,
            embeddingModel: true,
            document: { select: { filename: true } },
          },
        });
        for (const r of rows) {
          // Drop sparse-only hits whose chunks were embedded under a
          // different model — keeps coverage semantics consistent with the
          // dense path.
          if (!opts.includeAllModels && r.embeddingModel !== currentIdentity) continue;
          if (
            opts.documentIds &&
            opts.documentIds.length > 0 &&
            !opts.documentIds.includes(r.documentId)
          ) {
            continue;
          }
          meta.set(r.id, {
            chunkId: r.id,
            documentId: r.documentId,
            filename: r.document?.filename ?? "",
            position: r.position,
            text: r.text,
            score: 0,
            embeddingModel: r.embeddingModel,
          });
        }
      }
      const denseList = denseHits.map((h) => ({ chunkId: h.row.metadata.chunkId }));
      const sparseList = sparseHits.filter((h) => meta.has(h.chunkId));
      ordered = reciprocalRankFusion([denseList, sparseList], { topK: poolSize });
    }

    let chosen = ordered
      .map((o) => meta.get(o.chunkId))
      .filter((m): m is NonNullable<typeof m> => Boolean(m));

    if (chosen.length > 0) {
      const liveChunkRows = await prisma.knowledgeChunk.findMany({
        where: { id: { in: chosen.map((c) => c.chunkId) }, projectId },
        select: { id: true },
      });
      const liveChunkIds = new Set(liveChunkRows.map((row) => row.id));
      chosen = chosen.filter((chunk) => liveChunkIds.has(chunk.chunkId));
    }

    if (opts.evidencePolicy) chosen = await filterPrimaryEvidence(chosen, opts.evidencePolicy);

    // Epic #157 — ACL filter BEFORE rerank so we never spend cross-encoder
    // budget on chunks we'll throw away. Loads `aclSubjects` from Prisma in a
    // single round-trip keyed by the candidate pool.
    let aclMismatch: string[] | undefined;
    if (opts.actor && chosen.length > 0) {
      const aclRows = await prisma.knowledgeChunk.findMany({
        where: { id: { in: chosen.map((c) => c.chunkId) } },
        select: { id: true, aclSubjects: true },
      });
      const aclMap = new Map(aclRows.map((r) => [r.id, parseAclSubjects(r.aclSubjects)] as const));
      const enriched = chosen.map((c) => ({
        ...c,
        aclSubjects: aclMap.get(c.chunkId) ?? [],
      }));
      const { allowed, deniedChunkIds } = filterAccessible(enriched, opts.actor);
      chosen = allowed;
      if (deniedChunkIds.length > 0) {
        if (opts.reportAclMismatch) aclMismatch = deniedChunkIds;
        // Audit-log the denial set (issue #151) — `aclMismatch` reason +
        // chunk ids. The actor identity is the search caller.
        try {
          audit({
            actor: { id: opts.actor.userId },
            action: "knowledge.search.acl_denied",
            target: { type: "project", id: projectId },
            metadata: {
              reason: "aclMismatch",
              role: opts.actor.role,
              chunkIds: deniedChunkIds,
            },
          });
        } catch {
          // Audit failures must never break the chat path.
        }
      }
    }

    // Optional cross-encoder rerank — gated on env / per-process singleton.
    let reranked = false;
    if (chosen.length > 0 && this.reranker.enabled) {
      const reorder = await this.reranker.rerank(
        query,
        chosen.map((c) => ({ chunkId: c.chunkId, text: c.text, score: c.score })),
      );
      const map = new Map(chosen.map((c) => [c.chunkId, c]));
      chosen = reorder
        .map((r) => {
          const base = map.get(r.chunkId);
          return base ? { ...base, score: r.score ?? base.score } : null;
        })
        .filter((c): c is NonNullable<typeof c> => Boolean(c));
      reranked = true;
    }

    const top = chosen.slice(0, k);
    const mapped: RetrievedChunk[] = top.map((m) => ({
      chunkId: m.chunkId,
      documentId: m.documentId,
      filename: m.filename,
      position: m.position,
      text: m.text,
      score: m.score,
      embeddingModel: m.embeddingModel,
    }));

    const coverage = await this.store.modelCoverage(projectId);
    const currentModel = currentIdentity;
    const matching = coverage.modelCounts[currentModel] ?? 0;
    const otherModels = Object.keys(coverage.modelCounts).filter((m) => m !== currentModel);
    if (coverage.totalChunks > 0 && otherModels.length > 0) {
      const warn: CoverageWarning = {
        totalChunks: coverage.totalChunks,
        matchingChunks: matching,
        mismatchedModels: otherModels,
        currentModel,
      };
      log.warn("partial model coverage", warn);
      return { hits: mapped, coverageWarning: warn, mode, reranked, aclMismatch };
    }
    return { hits: mapped, mode, reranked, aclMismatch };
  }

  /** Best-effort BM25 lookup — degrades hybrid → dense if BM25 is unavailable. */
  private async runBM25Safe(
    projectId: string,
    query: string,
    k: number,
  ): Promise<{ chunkId: string; score: number }[]> {
    try {
      return await this.bm25.search(projectId, query, k);
    } catch (err) {
      log.warn("BM25 search failed, hybrid degraded to dense-only", {
        projectId,
        error: (err as Error).message,
      });
      return [];
    }
  }

  /** Delete a document and its associated chunks/vectors. */
  async deleteDocument(documentId: string): Promise<void> {
    const doc = await prisma.document.findFirst({
      where: { id: documentId, deletedAt: null },
    });
    if (!doc) return;
    // Fence workers before external deletion; their journals must outlive them.
    await prisma.$transaction(async (tx) => {
      await tx.document.update({
        where: { id: documentId },
        data: { deletedAt: new Date(), status: "failed", errorMessage: "deleted", chunkCount: 0 },
      });
      await tx.quarantineChunk.updateMany({
        where: { documentId, ord: { in: [-2, -3, -4] } },
        data: { ord: -1 },
      });
      await tx.quarantineChunk.deleteMany({ where: { documentId, ord: { gte: 0 } } });
    });
    await prisma.knowledgeChunk.deleteMany({ where: { documentId } });
    await this.store.deleteByDocument(doc.projectId, documentId);
    try {
      await this.bm25.removeDocument(doc.projectId, documentId);
    } catch (err) {
      log.warn("BM25 remove failed", { documentId, error: (err as Error).message });
    }
    await prisma.document.update({
      where: { id: documentId },
      data: { deletedAt: new Date(), status: "failed", errorMessage: "deleted", chunkCount: 0 },
    });
    try {
      await this.storage.remove(doc.storagePath);
    } catch (err) {
      log.warn("blob removal failed", {
        documentId,
        error: (err as Error).message,
      });
    }
  }

  /**
   * Drop a project's entire vector table. Wired to the project ARCHIVE hook.
   *
   * ## Issue #798 — the door #787 left open
   *
   * This drops BOTH the live table and the shadow, and it took NO lock at all. So:
   * archive the project on replica A while replica B is mid-reindex, and B's next
   * upsert recreates the shadow, B's swap recreates the LIVE index — and the archived
   * project ends up with a live vector index built after it was archived.
   *
   * It is now wrapped in the lease. But unlike a reindex or a discard, an archive is
   * taken FAIL-SAFE, not fail-closed: it FORCE-takes the lease rather than being
   * refused by whoever holds it. Two reasons.
   *
   *   1. An archive is an administrative decision the operator has already made; it
   *      must not be indefinitely blockable by a reindex, and a user staring at a
   *      "cannot archive: a reindex is running" error has no lever to pull.
   *   2. Fencing gives us the safe version of "just drop it anyway" for free. Taking
   *      the lease REVOKES B's fencing token, so B's next per-batch renew returns
   *      false and its pre-swap `assertHeld` throws: B aborts before it can write
   *      anything more, instead of racing our drop. Force-taking is therefore STRONGER
   *      than waiting — waiting would leave B free to rebuild what we are deleting.
   *
   * ## The one thing force-taking does NOT close (known, bounded)
   *
   * B's per-batch fence is `renew()` THEN `upsert()` — two statements. If we force-take
   * between them, B's in-flight upsert still lands, AFTER we dropped the shadow:
   *
   *   B: renew() → true │ A: force-take │ A: drop(live) │ A: drop(shadow) │ B: upsert(shadow)
   *
   * B is fenced and aborts at its next renew, so it can never SWAP (that is the
   * guarantee, and `assertHeld` + `FOR UPDATE` enforce it atomically — no data loss, the
   * live index is gone and stays gone). But B has recreated up to ONE BATCH of shadow
   * rows for a project that no longer exists: orphan vectors nothing will read (search
   * is scoped to the live namespace) and nothing currently sweeps.
   *
   * That is a leak, not a correctness bug, and closing it properly means fencing the
   * UPSERT transactionally the way the swap is fenced — a change to the `VectorStore`
   * write path, out of scope here. TODO(#798-follow-up): sweep shadow namespaces whose
   * project is archived. Until then an operator can clear one with
   * `embeddings:migrate discard --project <id>`.
   */
  async dropProject(projectId: string): Promise<void> {
    let dropping = false;
    const drop = async (lease?: ReindexLease): Promise<void> => {
      dropping = true;
      await this.store.dropTable(projectId);
      // Issue #787 — a retained reindex checkpoint must not outlive the project it
      // is a checkpoint OF, or an archived project leaves orphan vectors behind.
      await this.store.dropTable(reindexShadowId(projectId)).catch(() => {});
      // Issue #797 — same reasoning for the project's SYMBOL vectors, which live in
      // their own `<projectId>__symbols` namespace (+ its shadow). Missing this,
      // an archived project would leak ~15k orphan vectors into `rag_vectors`.
      //
      // PR #803 review (D2) — the LEASE IS PASSED IN. Sitting lexically inside the leased
      // closure was never the guarantee: what stops a concurrent symbol embed (fired
      // fire-and-forget from EVERY code-graph ingest) or a phase-2 reindex from writing
      // the table back after we drop it is that (a) the force-take above REVOKES their
      // fencing token, and (b) they now re-prove that token before every write. Handing
      // the lease down keeps this drop honest about which lease it is acting under, and
      // makes it abort if someone force-took ours in turn.
      await this.symbols.dropProject(projectId, lease).catch((err: unknown) => {
        log.warn("symbol vector drop failed", { projectId, error: (err as Error).message });
      });
    };

    try {
      await withReindexLease(projectId, drop, this.leaseOpts({ force: true, heartbeat: false }));
    } catch (err) {
      // If the DROP ITSELF failed, that IS the archive failing — propagate.
      if (dropping) throw err;
      // Otherwise the LEASE failed (Postgres unreachable, DDL error on the lazy
      // `CREATE UNLOGGED TABLE`, permissions) — a reason with nothing to do with a
      // reindex. `force: true` makes the lease unable to REFUSE us; it does not make it
      // unable to FAIL on us, and an archive that cannot proceed because a lease table
      // would not create itself is exactly the un-pullable lever this path exists to
      // avoid. Drop anyway, unfenced, loudly: the degraded case reverts to pre-#798
      // behaviour (a concurrent reindex could rebuild what we delete), which is strictly
      // better than an archive that cannot complete at all.
      log.warn("reindex lease unavailable — dropping project vectors UNFENCED (fail-safe)", {
        projectId,
        error: (err as Error).message,
      });
      await drop();
    }

    try {
      this.bm25.dropProject(projectId);
    } catch (err) {
      log.warn("BM25 drop failed", { projectId, error: (err as Error).message });
    }
  }

  /**
   * Epic #930 / issue #937 — report embedding-model coverage for a project so
   * operators can decide whether a re-index is required after switching
   * backends. Compares the persisted per-chunk `embeddingModel` against the
   * currently-active embedder.
   */
  async coverageReport(projectId: string): Promise<CoverageReport> {
    assertProjectId(projectId);
    // #792 — the composite identity, so a pooling/dtype flip (same model id)
    // reports as a mismatch and drives a reindex.
    const currentModel = await this.currentEmbeddingIdentity();
    const currentDimension = this.embedder.dimension;
    const grouped = await prisma.knowledgeChunk.groupBy({
      by: ["embeddingModel"],
      where: { projectId },
      _count: { _all: true },
    });
    const modelCounts: Record<string, number> = {};
    let totalChunks = 0;
    for (const g of grouped) {
      modelCounts[g.embeddingModel] = g._count._all;
      totalChunks += g._count._all;
    }
    const matchingChunks = modelCounts[currentModel] ?? 0;

    // Issue #797 — symbols count too. If they did not, a deployment whose symbol
    // vectors were all still hash-tagged would report a clean bill of health.
    //
    // #792 — symbols are compared against the bare MODEL ID, documents against the
    // composite IDENTITY. The pooling/dtype identity is scoped to the document
    // chunk corpus (this issue); the code-symbol corpus keeps its model-id key
    // (#797's domain). Using one "current" value for both would make every project
    // with symbols report a permanent mismatch after a pooling flip, since the
    // symbol reindex retags to the model id, never to the composite identity.
    const currentSymbolModel = this.embedder.model;
    const symbolCoverage = await this.symbols.coverage(projectId);
    const matchingSymbols = symbolCoverage.modelCounts[currentSymbolModel] ?? 0;
    const pendingGeneration = this.store.withProjectWrite
      ? await this.store.withProjectWrite(
          projectId,
          async (write) => (await write.readGeneration())?.pending === true,
        )
      : false;

    // Issue #1182 — the chunker generation split, in its own groupBy. A separate
    // query rather than a composite `by: ["embeddingModel", "chunkerIdentity"]`
    // because the two are reported and remedied independently; crossing them would
    // produce a matrix an operator has to decompose to act on either half.
    const chunkerGrouped = await prisma.knowledgeChunk.groupBy({
      by: ["chunkerIdentity"],
      where: { projectId },
      _count: { _all: true },
    });
    const currentChunkerIdentity = this.currentChunkerIdentity();
    const chunkerCounts: Record<string, number> = {};
    let matchingChunkerChunks = 0;
    let driftedChunkerChunks = 0;
    for (const g of chunkerGrouped) {
      // NULL collapses to "" — the same convention #797 uses for a symbol row with
      // no vector yet. It is a real generation (pre-#1182), not missing data.
      chunkerCounts[g.chunkerIdentity ?? ""] = g._count._all;
      // `foreign` rows are EXCLUDED from the verdict, not counted as drift: they are
      // another producer's correct output (`docs-gen/rag-ingest.ts` cuts its own
      // 1,500-char chunks). Comparing them to this chunker's identity produced a
      // mismatch no remedy could clear — PR #1182's review panel caught it pinning
      // `status` at exit 3 forever on 2 of 3 real projects.
      switch (classifyChunkerIdentity(g.chunkerIdentity, currentChunkerIdentity)) {
        case "current":
          matchingChunkerChunks += g._count._all;
          break;
        case "drifted":
        case "untagged":
          driftedChunkerChunks += g._count._all;
          break;
        case "foreign":
          break;
      }
    }

    const chunkMismatched = Object.keys(modelCounts).filter((m) => m !== currentModel);
    const symbolMismatched = Object.keys(symbolCoverage.modelCounts).filter(
      (m) => m !== currentSymbolModel,
    );
    const mismatchedModels = [...new Set([...chunkMismatched, ...symbolMismatched])].sort();

    return {
      totalChunks,
      modelCounts,
      currentModel,
      currentDimension,
      matchingChunks,
      mismatchedModels,
      totalSymbols: symbolCoverage.totalSymbols,
      symbolModelCounts: symbolCoverage.modelCounts,
      matchingSymbols,
      needsReindex:
        pendingGeneration ||
        (totalChunks > 0 && chunkMismatched.length > 0) ||
        (symbolCoverage.totalSymbols > 0 && symbolMismatched.length > 0),
      currentChunkerIdentity,
      chunkerCounts,
      matchingChunkerChunks,
      needsReingest: driftedChunkerChunks > 0,
    };
  }

  /**
   * Issue #1182 — the chunker generation the ACTIVE configuration would produce.
   *
   * The mirror of {@link currentEmbeddingIdentity} for the other half of what a
   * stored chunk is: `currentEmbeddingIdentity` answers "how would we vectorise
   * this text now", this answers "where would we cut it now". Resolved from the
   * service's own effective `chunkOptions`, so an env-clamped overlap (#1185)
   * reports the value that would actually be used rather than the one requested.
   */
  private currentChunkerIdentity(): string {
    return chunkerIdentity(this.chunkOptions);
  }

  /**
   * Epic #930 / issue #937 — re-embed every persisted chunk in a project with
   * the currently-active embedder and rebuild the vector table at the new
   * dimension. This is the migration path when an operator swaps embedding
   * backends (e.g. local Xenova → Bedrock) where the vector dimension changes
   * and the existing fixed-dimension table can no longer be queried.
   *
   * The fresh index is built into a transient SHADOW table while the LIVE
   * table keeps serving the OLD vectors for the entire embed loop. Only after
   * every batch succeeds is the shadow atomically swapped into the live name
   * (issue #941). On ANY failure the shadow is discarded and the live table is
   * left untouched, so searches never observe an empty or half-built index. A
   * per-project mutex rejects concurrent reindexes with {@link ReindexConflictError}.
   *
   * Chunk text is the source of truth (BM25 text is unchanged, so the sparse
   * index is left intact). Work is batched and reports progress so the UI can
   * show a live bar over a Socket.IO/poll surface.
   */
  async reindexProject(projectId: string, opts: ReindexOptions = {}): Promise<ReindexResult> {
    assertProjectId(projectId);
    // Issue #100 — fast path: an in-process reindex for this project short-
    // circuits before we ever touch the DB. The lease below is the CROSS-process
    // guard for multi-replica deployments.
    if (this.reindexing.has(projectId)) {
      throw new ReindexConflictError(projectId);
    }
    // PR #803 review (D3) — and refuse AT THE DOOR if this pod is already embedding the
    // project's symbols. Across replicas the lease below does this for us (the symbol
    // embed holds the SAME lease). This is the SQLite/dev answer, where the lease backend
    // is a no-op: without it, phase 2 would collide with the running embed only AFTER the
    // document index had already been swapped and retagged — a half-migrated project that
    // no retry can finish, which is precisely the wedge the advisory lock used to create.
    if (this.symbols.isBusy(projectId)) {
      throw new ReindexConflictError(projectId);
    }
    this.reindexing.add(projectId);
    // Issue #798 — back the in-process Set with a LEASE (was: a session advisory
    // lock, which leaked across Prisma's pool and could wedge the project until the
    // pod restarted). `withReindexLease` mints a fresh holder — `<podId>:<runId>` —
    // for THIS attempt: that string is the fencing token every mutating step below
    // re-proves it still owns. No-op on the SQLite runtime, where the Set above is
    // the only guard there can be.
    try {
      return await withReindexLease(
        projectId,
        async (lease) => {
          const documents = await this.runReindex(projectId, opts, lease);
          // Issue #797 — PHASE 2: the code-symbol vectors. Runs inside the SAME LEASE
          // (merge of #797 with #798: the lease replaced the advisory lock, and phase 2
          // must stay under whatever the single-writer guard currently is), and AFTER
          // the document swap so a failure here cannot leave the (larger, more visible)
          // document index half-built. The symbol shadow is retained on failure exactly
          // like the document one, so a retry resumes rather than re-embedding from zero.
          //
          // This is what makes `embed-migrate` honest. Without it a model flip would
          // re-embed every document chunk, report a green fully-migrated deployment,
          // and leave every code-symbol vector on the previous generation — where the
          // model-tag filter would ignore it and `search_code_symbols` would silently
          // drop back to BM25-only, i.e. straight back into the #797 defect.
          //
          // PR #803 review (D1) — the LEASE IS PASSED IN, and that is the whole point.
          // Being called from inside this closure orders phase 2 after the document swap;
          // it does not fence it. `reindexProject` re-proves this exact fencing token
          // before every batch, at its cut-over, inside its `swapTable` transaction, and
          // before it retags Prisma — so an archive (or an operator's force-unlock) that
          // steals the lease mid-phase-2 stops it dead instead of letting it resurrect the
          // symbol table it was told to abandon.
          const symbols = await this.symbols.reindexProject(
            projectId,
            {
              ...(opts.batchSize !== undefined ? { batchSize: opts.batchSize } : {}),
              ...(opts.fresh !== undefined ? { fresh: opts.fresh } : {}),
            },
            lease,
          );
          return { ...documents, symbols: symbols.totalSymbols > 0 ? symbols : null };
        },
        this.leaseOpts(),
      );
    } finally {
      this.reindexing.delete(projectId);
    }
  }

  /**
   * Issue #792 — the identity the ACTIVE embedder produces now (`model` at
   * built-in defaults, else `model|pooling|dtype`). Every "does the corpus match
   * what we'd produce?" comparison — coverage, reindex resume, retag — keys on
   * this instead of the bare model id, so flipping `EMBED_POOLING*`/`EMBED_DTYPE`
   * invalidates reuse and drives a reindex.
   *
   * Guarded for test doubles: a fake embedder that predates `currentIdentity`
   * falls back to its `model`, which is exactly the bare identity those fakes
   * already persist — so behaviour is unchanged for the default/offline path.
   */
  private async currentEmbeddingIdentity(): Promise<string> {
    const embedder = this.embedder as {
      currentIdentity?: () => Promise<string> | string;
      model: string;
    };
    if (typeof embedder.currentIdentity === "function") {
      return embedder.currentIdentity();
    }
    return embedder.model;
  }

  /** Issue #798 — thread the injected lease backend (if any) into the lease helpers. */
  private leaseOpts<T extends Record<string, unknown>>(extra?: T): T & { backend?: never } {
    return {
      ...(this.leaseBackend ? { backend: this.leaseBackend } : {}),
      ...(extra ?? ({} as T)),
    } as T & { backend?: never };
  }

  private async runReindex(
    projectId: string,
    opts: ReindexOptions,
    lease: ReindexLease,
  ): Promise<ReindexResult> {
    const started = Date.now();
    const batchSize = clamp(opts.batchSize ?? 128, 1, 1000);
    // #792 — the composite identity is what a resumed shadow's rows are tagged
    // with and what the swap retags Prisma to, so a run started after a
    // pooling/dtype flip cannot resume a shadow built at the old identity (it is
    // "foreign" and discarded in `resumableShadowIds`).
    const currentModel = await this.currentEmbeddingIdentity();
    const currentDimension = this.embedder.dimension;

    const chunks = await prisma.knowledgeChunk.findMany({
      where: { projectId },
      select: {
        id: true,
        documentId: true,
        position: true,
        text: true,
        embeddingModel: true,
        document: { select: { filename: true } },
      },
      orderBy: [{ documentId: "asc" }, { position: "asc" }],
    });

    const previousModels = [...new Set(chunks.map((c) => c.embeddingModel))].sort();
    // Membership, not createdAt, determines which chunks the shadow covers.
    const snapshotChunkIds = new Set(chunks.map((c) => c.id));

    // Build the new index into a shadow table. The live table keeps serving the
    // OLD vectors until the swap, so a mid-loop embed failure is invisible to
    // searches.
    const shadowId = reindexShadowId(projectId);
    // Issue #787 — RESUME. A reindex of a real corpus takes minutes to hours, and
    // the things that interrupt it (pod eviction, OOM kill, a rolling deploy) are
    // ordinary, not exceptional. Before #787 the shadow was dropped on the way in
    // AND on the way out of a failure, so every interruption meant re-embedding
    // the whole project from zero — which, on a long enough corpus, is a reindex
    // that can never finish on a cluster that evicts pods.
    //
    // The shadow IS the checkpoint. Its rows are exactly the chunks already
    // re-embedded at the new model, so resuming is "skip the ids that are already
    // there". There is no separate progress table that could disagree with it
    // after a SIGKILL, which is the whole reason to derive the checkpoint from the
    // data rather than record it alongside.
    const resumed = await this.resumableShadowIds(
      shadowId,
      currentModel,
      currentDimension,
      snapshotChunkIds,
      opts,
    );
    await this.store.ensureTable(shadowId);

    const pending = chunks.filter((c) => !resumed.has(c.id));
    let embedded = 0;
    const report = (): void => {
      try {
        opts.onProgress?.({ processed: resumed.size + embedded, total: chunks.length });
      } catch {
        // progress callback failure must never abort the migration
      }
    };
    // Emit the resume point immediately so a restarted job's progress bar starts
    // where the last one stopped instead of snapping back to 0%.
    if (resumed.size > 0) report();

    try {
      for (let i = 0; i < pending.length; i += batchSize) {
        const batch = pending.slice(i, i + batchSize);
        const embedResult = await this.embedder.embed(batch.map((c) => c.text));
        const { vectors } = embedResult;
        // #792 — tag rows with the composite identity, not the bare model id.
        const tag = embedResult.identity ?? embedResult.model;
        if (vectors.length !== batch.length) {
          throw new Error(
            `reindex embedder returned ${vectors.length} vectors for ${batch.length} chunks`,
          );
        }
        if (
          tag !== currentModel ||
          vectors.some(
            (vector) => vector.length !== currentDimension || !vector.every(Number.isFinite),
          )
        ) {
          throw new Error("Reindex embedding identity/dimension changed during migration");
        }
        const rows: VectorRow[] = batch.map((c, j) => ({
          id: c.id,
          vector: vectors[j],
          metadata: {
            chunkId: c.id,
            documentId: c.documentId,
            filename: c.document?.filename ?? "",
            position: c.position,
            text: c.text,
            embeddingModel: tag,
          },
        }));
        // Issue #798 — THE FENCE, per batch, BEFORE the upsert.
        //
        // A plain TTL lease would re-open the very data-loss path #787 closed: this
        // run stalls (GC pause, sidecar backpressure, a 90s partition), its lease
        // lapses, another replica's `discard` legitimately takes the free lease and
        // drops the shadow — and then this run's next upsert RECREATES that shadow
        // and swaps a PARTIAL index over the live one. So a run must re-prove it owns
        // the lease at the instant it writes. `renew()` is that proof and that
        // extension in one statement: zero rows updated ⇒ someone else has taken or
        // released the lease ⇒ we have been FENCED ⇒ abort BEFORE the upsert.
        //
        // Be precise about what this buys, because the strong version of the claim is
        // FALSE: renew-then-upsert is TWO statements, so a run fenced in the gap between
        // them can still land the upsert already in flight, briefly recreating a shadow
        // that was just discarded. What it CANNOT do is swap that shadow over the live
        // index — that is the guarantee, and it is enforced separately and atomically by
        // `assertHeld` + `SELECT … FOR UPDATE` inside the swap's own transaction. So the
        // residue of a fenced run is bounded to ONE batch of orphan SHADOW rows (never
        // live ones, never a partial cut-over), cleared by the next `discard`/`--fresh`.
        // See the note on `dropProject()`.
        if (!(await lease.renew())) throw new ReindexFencedError(projectId, lease.holder);
        await this.store.upsert(shadowId, rows);
        embedded += batch.length;
        report();
      }
    } catch (err) {
      // Issue #787 — KEEP the half-built shadow. It is the resume checkpoint, and
      // the live table is untouched either way (nothing has been swapped yet), so
      // there is nothing to protect by dropping it and a whole re-embed to lose.
      // A shadow whose model tag no longer matches the active embedder is
      // discarded on the next run (see `resumableShadowIds`), so an ABANDONED
      // migration cannot leave one behind that is ever resumed into the wrong
      // vector space. `--fresh` / `fresh: true` forces a clean rebuild.
      log.warn("reindex interrupted — shadow retained as a resume checkpoint", {
        projectId,
        shadowChunks: resumed.size + embedded,
        totalChunks: chunks.length,
        error: (err as Error).message,
      });
      throw err;
    }
    const processed = resumed.size + embedded;

    // Approval's FINAL selection shares this section, but its speculative
    // vector/BM25 writes do not. Catch up once by SQL membership BEFORE swap;
    // there is no post-swap embedding window in which indexed rows lack vectors.
    const cutover = async (write: ProjectVectorWrite): Promise<number> => {
      const applied = await withVectorSql(write, async (tx) => {
        await lease.assertHeld(write.sql);
        const live = await tx.knowledgeChunk.findMany({
          where: { projectId },
          select: {
            id: true,
            documentId: true,
            position: true,
            text: true,
            document: { select: { filename: true } },
          },
          orderBy: [{ documentId: "asc" }, { position: "asc" }],
        });
        const refs = await write.listChunkRefs(shadowId);
        if (refs.some((ref) => !matchesEmbeddingGeneration(ref, currentModel, currentDimension))) {
          throw new Error("Reindex shadow embedding generation changed");
        }
        const covered = new Set(refs.map((ref) => ref.chunkId));
        const missing = live.filter((chunk) => !covered.has(chunk.id));
        for (let i = 0; i < missing.length; i += batchSize) {
          const batch = missing.slice(i, i + batchSize);
          const result = await this.embedder.embed(batch.map((chunk) => chunk.text));
          const tag = result.identity ?? result.model;
          if (
            tag !== currentModel ||
            result.vectors.length !== batch.length ||
            result.vectors.some(
              (vector) => vector.length !== currentDimension || !vector.every(Number.isFinite),
            )
          ) {
            throw new Error("Reindex catch-up embedding identity/dimension changed");
          }
          await lease.assertHeld(write.sql);
          await write.upsert(
            shadowId,
            batch.map((chunk, index) => ({
              id: chunk.id,
              vector: result.vectors[index],
              metadata: {
                chunkId: chunk.id,
                documentId: chunk.documentId,
                filename: chunk.document?.filename ?? "",
                position: chunk.position,
                text: chunk.text,
                embeddingModel: tag,
              },
            })),
          );
        }
        // Re-read deletions after embedding; approvals cannot add selected IDs
        // while we hold coordination. Prune the SHADOW, never the replaced live.
        const selected = new Set(
          (
            await tx.knowledgeChunk.findMany({
              where: { projectId },
              select: { id: true },
            })
          ).map((chunk) => chunk.id),
        );
        const shadow = await write.listChunkRefs(shadowId);
        if (
          shadow.some((ref) => !matchesEmbeddingGeneration(ref, currentModel, currentDimension))
        ) {
          throw new Error("Reindex shadow embedding generation changed");
        }
        await write.deleteByChunkIds(
          shadowId,
          shadow.filter((ref) => !selected.has(ref.chunkId)).map((ref) => ref.chunkId),
        );
        const shadowIds = new Set(shadow.map((ref) => ref.chunkId));
        if ([...selected].some((id) => !shadowIds.has(id))) {
          throw new Error("Reindex SQL membership changed outside project coordination; retry");
        }
        // File stores persist this BEFORE destructive cutover. A failure or lost
        // commit ACK leaves approvals fail-closed until a reindex retry completes.
        await write.writeGeneration({
          model: currentModel,
          dimension: currentDimension,
          pending: true,
        });
        await write.swapTable(projectId, shadowId, lease);
        const ids = [...selected];
        for (let i = 0; i < ids.length; i += batchSize) {
          await tx.knowledgeChunk.updateMany({
            where: { projectId, id: { in: ids.slice(i, i + batchSize) } },
            data: { embeddingModel: currentModel },
          });
        }
        // Deletion/retired-generation cleanup does not take project coordination.
        // A delete can finish after the last membership read but before swap.
        // Reconcile ONLY the immutable IDs this cutover selected, never all live
        // refs: speculative/concurrent winners are not ours to remove. PostgreSQL
        // READ COMMITTED observes completed deletes here; SQLite serializes SQL
        // writers, whose subsequent physical delete runs after our swap instead.
        for (let i = 0; i < ids.length; i += batchSize) {
          const batch = ids.slice(i, i + batchSize);
          const remaining = new Set(
            (
              await tx.knowledgeChunk.findMany({
                where: { projectId, id: { in: batch } },
                select: { id: true },
              })
            ).map((chunk) => chunk.id),
          );
          await write.deleteByChunkIds(
            projectId,
            batch.filter((id) => !remaining.has(id)),
          );
        }
        return missing.length;
      });
      // For file stores SQL has committed before clearing the durable intent.
      // PostgreSQL keeps this descriptor and all preceding mutations in ONE tx.
      await write.writeGeneration({
        model: currentModel,
        dimension: currentDimension,
        pending: false,
      });
      return applied;
    };
    await lease.assertHeld();
    const reindexedDelta = await lease.withHeartbeatPaused(() =>
      this.store.withProjectWrite
        ? this.store.withProjectWrite(projectId, cutover)
        : cutover({
            // Structural test doubles only; real store errors never fall back.
            upsert: (id, rows) => this.store.upsert(id, rows),
            listChunkRefs: (id) => this.store.listChunkRefs(id),
            deleteByChunkIds: (id, ids) => this.store.deleteByChunkIds(id, ids),
            swapTable: (id, shadow, guard) => this.store.swapTable(id, shadow, guard),
            readGeneration: async () => null,
            writeGeneration: async () => {},
          }),
    );

    log.info("project reindexed", {
      projectId,
      totalChunks: chunks.length,
      previousModels,
      currentModel,
      currentDimension,
      resumedChunks: resumed.size,
      embeddedChunks: embedded + reindexedDelta,
    });

    return {
      projectId,
      totalChunks: chunks.length,
      reindexedChunks: processed + reindexedDelta,
      previousModels,
      currentModel,
      currentDimension,
      durationMs: Date.now() - started,
      resumedChunks: resumed.size,
      embeddedChunks: embedded + reindexedDelta,
      symbols: null,
    };
  }

  /**
   * Issue #787 — decide which of a surviving shadow's rows may be RESUMED, and
   * clean up the ones that may not.
   *
   * Three things can be wrong with a shadow left behind by an interrupted run,
   * and each is a different answer:
   *
   *   1. `fresh` was requested → resume nothing; drop the shadow.
   *   2. The shadow carries rows from ANOTHER model or vector dimension — an abandoned migration
   *      (reindex started at model A, operator flipped to B, restarted). Resuming
   *      would build one table out of two vector spaces, which is precisely the
   *      failure the model tagging exists to prevent. Drop the whole shadow: we
   *      cannot know which rows are trustworthy, and a partial keep is worse than
   *      a clean rebuild.
   *   3. The shadow holds rows for chunks that no longer EXIST (a document was
   *      deleted or re-ingested since the interrupted run). Those ids would
   *      survive the swap as live orphans, so they are deleted from the shadow —
   *      but the rest of it is still perfectly good and is resumed.
   *
   * ## The invariant the whole resume design rests on
   *
   * A chunk id is NEVER REUSED WITH DIFFERENT TEXT. That is what makes it safe to
   * decide reusability from `(chunkId, embeddingModel, dimension)` alone: if a chunk's text
   * could change under a stable id, a resumed run would skip re-embedding it and
   * swap a STALE vector into the live index — silently, with the Prisma tag updated
   * to say it is current.
   *
   * It holds because re-ingest is delete + create, never update: `ingestDocument()`
   * (and `quarantine.ts`) `deleteMany` a document's chunks and `create` new ones, so
   * changed text always arrives under a BRAND-NEW id and the old id becomes an
   * orphan that case 3 above prunes. If that ever stops being true, THIS is the code
   * that breaks, and it breaks quietly.
   */
  private async resumableShadowIds(
    shadowId: string,
    currentModel: string,
    currentDimension: number,
    snapshotChunkIds: Set<string>,
    opts: ReindexOptions,
  ): Promise<Set<string>> {
    if (opts.fresh) {
      await this.store.dropTable(shadowId).catch(() => {});
      return new Set();
    }

    let refs;
    try {
      refs = await this.store.listChunkRefs(shadowId);
    } catch (err) {
      // A shadow we cannot even READ is a shadow we cannot trust. Rebuild.
      log.warn("could not read reindex shadow — rebuilding from scratch", {
        shadowId,
        error: (err as Error).message,
      });
      await this.store.dropTable(shadowId).catch(() => {});
      return new Set();
    }
    if (refs.length === 0) {
      // Nothing to resume. Still drop it: an EMPTY shadow table may have been
      // materialised at the wrong width by an earlier run's `ensureTable`.
      await this.store.dropTable(shadowId).catch(() => {});
      return new Set();
    }

    const foreign = refs.filter(
      (r) => !matchesEmbeddingGeneration(r, currentModel, currentDimension),
    );
    if (foreign.length > 0) {
      log.warn("discarding reindex shadow from a different embedding generation", {
        shadowId,
        currentModel,
        currentDimension,
        shadowModels: [...new Set(foreign.map((r) => r.embeddingModel))],
        shadowDimensions: [...new Set(foreign.map((r) => r.dimension))],
        discardedChunks: refs.length,
      });
      await this.store.dropTable(shadowId).catch(() => {});
      return new Set();
    }

    const orphans = refs.filter((r) => !snapshotChunkIds.has(r.chunkId)).map((r) => r.chunkId);
    if (orphans.length > 0) {
      await this.store.deleteByChunkIds(shadowId, orphans);
      log.info("pruned stale chunks from a resumed reindex shadow", {
        shadowId,
        orphanChunks: orphans.length,
      });
    }

    const resumable = new Set(
      refs.filter((r) => snapshotChunkIds.has(r.chunkId)).map((r) => r.chunkId),
    );
    log.info("resuming an interrupted reindex from its shadow", {
      shadowId,
      resumedChunks: resumable.size,
    });
    return resumable;
  }

  /**
   * Issue #787 — report a project's shadow state so an operator can tell an
   * interrupted-and-resumable reindex apart from one that never started.
   */
  async reindexShadowState(projectId: string): Promise<ReindexShadowState> {
    assertProjectId(projectId);
    const shadowId = reindexShadowId(projectId);
    let refs: Awaited<ReturnType<VectorStore["listChunkRefs"]>> = [];
    try {
      refs = await this.store.listChunkRefs(shadowId);
    } catch {
      // An unreadable shadow reports as absent; the next reindex rebuilds it.
    }
    const shadowModels = [...new Set(refs.map((r) => r.embeddingModel))].sort();
    // PR #796 review (B3) — `inProgress` used to be read off the replica-local Set
    // alone, so replica A cheerfully reported `resumable: true` for a project
    // replica B was actively reindexing, and an operator who trusted that then went
    // looking for the "discard" button. The reindex LEASE is the CROSS-PROCESS truth,
    // so ask it. A plain read: unlike a try-lock probe it cannot itself steal the
    // lease from a reindex that is starting at this instant.
    //
    // Issue #798 — this is now a bare `SELECT` from our OWN database, and it reports
    // WHO holds the lease and for how long instead of a bare boolean. (The advisory-
    // lock version read `pg_locks` without scoping to the current database, so a
    // sibling METIS on a shared cluster could make it report a phantom reindex.)
    const lease = await readReindexLease(projectId, this.leaseOpts());
    const inProgress = this.reindexing.has(projectId) || (lease !== null && !lease.expired);
    // #792 — resumable only when the shadow's single identity matches what the
    // active embedder produces now, so a shadow left behind before a pooling/dtype
    // flip is reported as NOT resumable (the next run discards it).
    const currentIdentity = await this.currentEmbeddingIdentity();
    return {
      projectId,
      inProgress,
      lease,
      shadowChunks: refs.length,
      shadowModels,
      resumable:
        refs.length > 0 &&
        shadowModels.length === 1 &&
        shadowModels[0] === currentIdentity &&
        !inProgress,
    };
  }

  /**
   * Issue #798 (AC 3) — the operator's `lock-status`: who holds this project's
   * reindex lease, since when, and has it expired? `null` = nobody.
   */
  async reindexLockStatus(projectId: string): Promise<ReindexLeaseInfo | null> {
    assertProjectId(projectId);
    return readReindexLease(projectId, this.leaseOpts());
  }

  /**
   * Issue #798 (AC 3) — the operator's `unlock`: clear a wedged lease WITHOUT
   * restarting the pod. Returns the lease that was cleared, or `null`.
   *
   * This is the escape hatch the advisory lock could not have: a session lock only
   * released on TCP disconnect, so the ONLY way to clear one was to kill the pod that
   * held it. Clearing a lease is also SAFE rather than merely possible — the run it
   * belonged to is fenced by the very act of clearing (its next renew fails, its swap
   * is refused), so an unlock issued against a still-running reindex costs a re-run,
   * never a corrupted index.
   */
  async forceReleaseReindexLock(projectId: string): Promise<ReindexLeaseInfo | null> {
    assertProjectId(projectId);
    // The in-process Set belongs to THIS replica: if the wedged run is ours, clear it
    // too, or the local fast path would keep refusing after the lease is gone.
    this.reindexing.delete(projectId);
    return forceReleaseReindexLease(projectId, this.leaseOpts());
  }

  /**
   * Issue #787 — throw away a project's reindex checkpoint. The operator's
   * "start over" button; also the cleanup for a migration that was abandoned.
   *
   * ## Why this takes the reindex lock (PR #796 review, B3)
   *
   * "Discard never touches the live index" is true DIRECTLY and false TRANSITIVELY.
   * The old guard was the process-local {@link reindexing} Set, while
   * {@link reindexProject} is ALSO backed by a Postgres session advisory lock —
   * which exists precisely because METIS runs multiple replicas on EKS. So:
   *
   *   - `DELETE /api/admin/embeddings/projects/:id/reindex` served by replica A
   *     while replica B is mid-reindex saw an empty Set on A and dropped the shadow.
   *   - `pnpm embeddings:migrate discard` is a SEPARATE PROCESS by construction (the
   *     runbook tells operators to `kubectl exec` it), so it could never see the
   *     server's Set at all.
   *
   * And the cost is not "you lose a checkpoint": the in-flight embed loop's next
   * `upsert` RECREATES the shadow, finishes, and `swapTable()` swaps a PARTIAL
   * shadow into the live name — reporting success while the live index silently
   * loses every chunk embedded before the discard.
   *
   * Taking the same lease the reindex takes makes that race impossible: a discard
   * either runs when no reindex holds a valid lease anywhere, or is refused with
   * {@link ReindexConflictError} (409). The lease is held for a single `dropTable` —
   * milliseconds — not for an embed loop.
   *
   * ## Issue #798 — and when it DOES steal an expired lease?
   *
   * A lease can lapse under a reindex that is merely SLOW (or partitioned) rather
   * than dead, and then this discard legitimately takes it and drops the shadow out
   * from under a run that is still alive. That is exactly the case fencing exists
   * for: the moment this discard takes the lease, the old run's fencing token is
   * void, so its next batch aborts before the upsert and its swap is refused. It can
   * no longer recreate the shadow, and it certainly cannot cut a partial index over
   * the live one. It fails; nothing is lost but the work.
   */
  async discardReindexShadow(projectId: string): Promise<void> {
    assertProjectId(projectId);
    if (this.reindexing.has(projectId)) throw new ReindexConflictError(projectId);
    // Throws ReindexConflictError when another PROCESS (another replica, or the
    // server while this is the CLI) holds a still-valid lease. No-op on a
    // non-Postgres runtime, where the in-process Set above is the only guard there
    // can be. `heartbeat: false` — the critical section is one `dropTable`.
    await withReindexLease(
      projectId,
      async () => {
        await this.store.dropTable(reindexShadowId(projectId));
      },
      this.leaseOpts({ heartbeat: false }),
    );
    log.info("reindex shadow discarded", { projectId });
  }

  /**
   * PR #796 review (S2) — re-label every chunk with the ACTIVE embedding model
   * WITHOUT re-embedding anything. The missing half of the `pg_dump` rollback.
   *
   * The runbook offered `pg_dump -t rag_vectors` as a fast path out of a bad model
   * flip, but there was no way to spend it: restoring the dump gives you back the
   * old generation's VECTORS, while every `KnowledgeChunk.embeddingModel` still says
   * the new model (the forward migration's `updateMany` set them). `reindex --all`
   * would then re-embed the entire corpus and swap its fresh shadow over the rows
   * you just restored — so the dump bought nothing. This closes that gap: it
   * reconciles the TAGS to the vectors an operator has just put back.
   *
   * It touches NO vectors. It is only correct when the stored vectors really were
   * produced by the active model — i.e. immediately after restoring a dump taken
   * while that model was active — which is why the CLI gates it behind `--force`,
   * a healthy embedder, and a column width that already matches (see
   * `retagRefusal`). Run it in any other state and coverage will confidently report
   * an index that does not exist.
   */
  async retagToActiveModel(): Promise<{
    model: string;
    retagged: number;
    /**
     * Issue #804 — chunks this retag REFUSED to vouch for: a Prisma row exists but
     * the store holds no live vector for it under the active identity (never
     * embedded, or its vector dropped by `prepare --force`). The old blanket
     * `updateMany` stamped these "current" anyway, so `coverageReport()` /
     * `deploymentCoverage()` — which derive health from the tags — then reported a
     * 100%-healthy index that did not exist (dense retrieval returned nothing;
     * BM25 masked it). These are exactly the chunks that still need a reindex; the
     * count is surfaced to the operator (CLI stdout + the structured log) so the
     * `--force` rollback path cannot silently lie about coverage.
     */
    skipped: number;
    retaggedSymbols: number;
  }> {
    // #792 — retag to the composite identity so a post-restore corpus is tagged
    // with the pooling/dtype the active embedder actually produces.
    const model = await this.currentEmbeddingIdentity();

    // Include already-matching SQL tags: a prior retag may have committed SQL
    // before its file descriptor write failed. Retry must repair that state too.
    const candidates = await prisma.knowledgeChunk.findMany({
      select: { id: true, projectId: true },
    });

    // Intersect with the vectors the store ACTUALLY holds, per project. A chunk is
    // only vouched-for when a live vector exists for it AND that vector is tagged
    // with the identity we are retagging TO (#792): a row with no vector — or one
    // whose vector belongs to a different generation — is REFUSED, not stamped.
    // `retag` claims "the vectors already in the store were produced by the active
    // model"; that claim is false for a chunk the store has never heard of, and a
    // false claim here is the whole bug (#804). The store surface is per-project,
    // so group the candidates by project and read each project's refs once.
    const projectIds = [...new Set(candidates.map((c) => c.projectId))];
    let retagged = 0;
    let skipped = 0;
    for (const projectId of projectIds) {
      const retag = async (write: ProjectVectorWrite): Promise<void> => {
        const reconcile = async (tx: Pick<typeof prisma, "knowledgeChunk">): Promise<boolean> => {
          const selected = await tx.knowledgeChunk.findMany({
            where: { projectId },
            select: { id: true, embeddingModel: true },
          });
          const mismatched = selected.filter((chunk) => chunk.embeddingModel !== model);
          let refs: StoredChunkRef[];
          try {
            refs = await write.listChunkRefs(projectId);
          } catch (err) {
            log.warn("retag could not read the vector store for a project — refusing its chunks", {
              projectId,
              error: (err as Error).message,
            });
            skipped += mismatched.length;
            return false;
          }
          const matching = new Set(
            refs
              .filter((ref) => matchesEmbeddingGeneration(ref, model, this.embedder.dimension))
              .map((ref) => ref.chunkId),
          );
          const ids = mismatched.filter((chunk) => matching.has(chunk.id)).map((chunk) => chunk.id);
          skipped += mismatched.length - ids.length;
          // A descriptor vouches for the generation, not just a subset. Never
          // clear pending/bless a mixed, wrong-width, or vectorless corpus.
          const complete =
            selected.every((chunk) => matching.has(chunk.id)) &&
            refs.every((ref) => matchesEmbeddingGeneration(ref, model, this.embedder.dimension));
          if (complete)
            await write.writeGeneration({
              model,
              dimension: this.embedder.dimension,
              pending: true,
            });
          for (let i = 0; i < ids.length; i += 500) {
            const { count } = await tx.knowledgeChunk.updateMany({
              where: {
                projectId,
                id: { in: ids.slice(i, i + 500) },
                embeddingModel: { not: model },
              },
              data: { embeddingModel: model },
            });
            retagged += count;
          }
          return complete;
        };
        const complete = this.store.withProjectWrite
          ? await withVectorSql(write, reconcile)
          : await reconcile(prisma);
        if (complete)
          await write.writeGeneration({
            model,
            dimension: this.embedder.dimension,
            pending: false,
          });
      };
      if (this.store.withProjectWrite) {
        await this.store.withProjectWrite(projectId, retag);
      } else {
        // Legacy structural doubles only; shipped stores all coordinate.
        await retag({
          upsert: (id, rows) => this.store.upsert(id, rows),
          listChunkRefs: (id) => this.store.listChunkRefs(id),
          deleteByChunkIds: (id, ids) => this.store.deleteByChunkIds(id, ids),
          swapTable: (id, shadow, guard) => this.store.swapTable(id, shadow, guard),
          readGeneration: async () => null,
          writeGeneration: async () => {},
        });
      }
    }

    // Issue #797 — symbol rows carry the same tag and are restored by the same
    // `pg_dump`, so they must be retagged by the same operation. Retagging only
    // half of the corpus would leave coverage reporting a state that is true for
    // documents and false for symbols. (The symbol retag already EXCLUDES its
    // PENDING sentinel, so it has never had #804's phantom-coverage bug.)
    const retaggedSymbols = await this.symbols.retagToActiveModel();
    log.warn("retagged chunks to the active embedding model without re-embedding", {
      model,
      retagged,
      skipped,
      retaggedSymbols,
    });
    return { model, retagged, skipped, retaggedSymbols };
  }

  /**
   * Issue #787 — the mixed-generation picture across EVERY project, in one query.
   *
   * `coverageReport()` answers "does THIS project need a reindex", which requires
   * the operator to already know which projects to ask about. During a model
   * migration the question is the other way round: which projects are still on the
   * old generation? One `groupBy` answers it for the whole deployment.
   *
   * Counted from `KnowledgeChunk` (Prisma), not from the vector store, on purpose:
   * chunk TEXT is the source of truth a reindex reads, so this is the set of work
   * the migration actually has to do — including chunks that have a row but no
   * vector at all.
   */
  async deploymentCoverage(): Promise<DeploymentCoverageReport> {
    // #792 — documents key on the composite identity, symbols (#797) on the bare
    // model id. See `coverageReport` for why the two corpora use different keys.
    const currentModel = await this.currentEmbeddingIdentity();
    const currentSymbolModel = this.embedder.model;
    const currentDimension = this.embedder.dimension;
    const grouped = await prisma.knowledgeChunk.groupBy({
      by: ["projectId", "embeddingModel"],
      _count: { _all: true },
    });

    const byProject = new Map<string, Record<string, number>>();
    const modelCounts: Record<string, number> = {};
    let totalChunks = 0;
    for (const g of grouped) {
      const n = g._count._all;
      const counts = byProject.get(g.projectId) ?? {};
      counts[g.embeddingModel] = (counts[g.embeddingModel] ?? 0) + n;
      byProject.set(g.projectId, counts);
      modelCounts[g.embeddingModel] = (modelCounts[g.embeddingModel] ?? 0) + n;
      totalChunks += n;
    }

    // Issue #1182 — the same picture for the CHUNKER generation. `""` is a real
    // bucket (rows whose provenance was never recorded), not absent data.
    const currentChunkerIdentity = this.currentChunkerIdentity();
    const chunkerGrouped = await prisma.knowledgeChunk.groupBy({
      by: ["projectId", "chunkerIdentity"],
      _count: { _all: true },
    });
    const chunkerByProject = new Map<string, Record<string, number>>();
    const chunkerCounts: Record<string, number> = {};
    for (const g of chunkerGrouped) {
      const n = g._count._all;
      const key = g.chunkerIdentity ?? "";
      const counts = chunkerByProject.get(g.projectId) ?? {};
      counts[key] = (counts[key] ?? 0) + n;
      chunkerByProject.set(g.projectId, counts);
      chunkerCounts[key] = (chunkerCounts[key] ?? 0) + n;
    }

    // Issue #797 — the symbol half. A project can have symbols and NO documents
    // (a repo-only project), so the project set is the UNION of both corpora, not
    // the chunk corpus alone. Getting this wrong is not cosmetic: `reindexAll`
    // drives off this list, so a repo-only project would never be migrated.
    const symbolsByProject = await this.symbols.deploymentCoverage();
    const symbolModelCounts: Record<string, number> = {};
    let totalSymbols = 0;
    for (const counts of symbolsByProject.values()) {
      for (const [model, n] of Object.entries(counts)) {
        symbolModelCounts[model] = (symbolModelCounts[model] ?? 0) + n;
        totalSymbols += n;
      }
    }

    const projectIds = new Set([...byProject.keys(), ...symbolsByProject.keys()]);
    const pendingProjects = new Set<string>();
    if (this.store.withProjectWrite) {
      for (const projectId of projectIds) {
        if (
          await this.store.withProjectWrite(
            projectId,
            async (write) => (await write.readGeneration())?.pending,
          )
        ) {
          pendingProjects.add(projectId);
        }
      }
    }
    const projects = [...projectIds]
      .map((projectId) => {
        const counts = byProject.get(projectId) ?? {};
        const symCounts = symbolsByProject.get(projectId) ?? {};
        const total = Object.values(counts).reduce((a, b) => a + b, 0);
        const matching = counts[currentModel] ?? 0;
        const symTotal = Object.values(symCounts).reduce((a, b) => a + b, 0);
        const symMatching = symCounts[currentSymbolModel] ?? 0;
        // #1182 — chunker generations for this project, classified the same way
        // `coverageReport` classifies them: `foreign` producers are excluded from the
        // verdict rather than counted as drift. One shared predicate
        // (`classifyChunkerIdentity`) drives both, so the per-project and
        // deployment-wide views cannot disagree the way two hand-written filters did
        // in #1191.
        const chunkerProjectCounts = chunkerByProject.get(projectId) ?? {};
        let chunkerMatching = 0;
        let chunkerDrifted = 0;
        for (const [identity, n] of Object.entries(chunkerProjectCounts)) {
          const cls = classifyChunkerIdentity(
            identity === "" ? null : identity,
            currentChunkerIdentity,
          );
          if (cls === "current") chunkerMatching += n;
          else if (cls !== "foreign") chunkerDrifted += n;
        }
        return {
          projectId,
          totalChunks: total,
          matchingChunks: matching,
          modelCounts: counts,
          totalSymbols: symTotal,
          matchingSymbols: symMatching,
          symbolModelCounts: symCounts,
          needsReindex:
            pendingProjects.has(projectId) || matching < total || symMatching < symTotal,
          chunkerCounts: chunkerProjectCounts,
          matchingChunkerChunks: chunkerMatching,
          needsReingest: chunkerDrifted > 0,
        };
      })
      .sort((a, b) => b.totalChunks + b.totalSymbols - (a.totalChunks + a.totalSymbols));

    return {
      currentModel,
      currentDimension,
      totalChunks,
      modelCounts,
      totalSymbols,
      symbolModelCounts,
      projects,
      projectsNeedingReindex: projects.filter((p) => p.needsReindex).length,
      currentChunkerIdentity,
      chunkerCounts,
      projectsNeedingReingest: projects.filter((p) => p.needsReingest).length,
    };
  }

  private async markFailed(
    projectId: string,
    documentId: string,
    message: string,
    ingestGeneration: string,
  ): Promise<IngestResult> {
    await prisma.$transaction(async (tx) => {
      await tx.document.updateMany({ where: { id: documentId }, data: { id: documentId } });
      const held = await tx.quarantineChunk.updateMany({
        where: { id: ingestGeneration, documentId, ord: -4 },
        data: { ord: -4 },
      });
      if (!held.count) return;
      // A selected winner owns its cleanup status/count, even when this worker
      // lost the race or the commit acknowledgement. Do not overwrite it.
      await tx.document.updateMany({
        where: { id: documentId, deletedAt: null, indexState: { in: ["pending", "quarantined"] } },
        data: { status: "failed", errorMessage: message, chunkCount: 0 },
      });
    });
    this.emitStatus(projectId, documentId, "failed", 0, message);
    log.warn("document ingest failed", { projectId, documentId, message });
    return { documentId, status: "failed", chunkCount: 0, errorMessage: message };
  }

  private emitStatus(
    projectId: string,
    documentId: string,
    status: "pending" | "processing" | "ready" | "failed",
    chunkCount?: number,
    errorMessage?: string | null,
  ): void {
    try {
      this.emit({
        type: "document:status",
        projectId,
        documentId,
        status,
        chunkCount,
        errorMessage: errorMessage ?? null,
      });
    } catch {
      // emitter failure must never break the pipeline
    }
  }
}

function noopEmit(): void {
  /* no-op */
}

/**
 * Chunking parameters from `RAG_CHUNK_SIZE` / `RAG_CHUNK_OVERLAP`, resolved through
 * the chunker's own rules so this service holds the EFFECTIVE configuration rather
 * than the requested one.
 *
 * The warning is the env half of #1185's clamp decision (see `chunker.ts`'s
 * {@link resolveChunkParams} for the full reasoning). An operator who sets
 * `RAG_CHUNK_OVERLAP` past the cap gets a working index with less carry-over, not a
 * failed ingest — but the reduction is announced, because an out-of-range overlap is
 * far more likely to be a misunderstanding than an intent, and #1178 is what a quiet
 * chunker costs. Once per process, at construction: the frequency of the mistake,
 * not of the documents.
 */
function resolveEnvChunkOptions(): ChunkOptions {
  const resolved = resolveChunkParams({
    chunkSize: parseIntEnv("RAG_CHUNK_SIZE", DEFAULT_RAG_CHUNK_SIZE),
    overlap: parseIntEnv("RAG_CHUNK_OVERLAP", DEFAULT_RAG_CHUNK_OVERLAP),
  });
  if (resolved.overlap < resolved.requestedOverlap) {
    log.warn(
      `RAG_CHUNK_OVERLAP=${resolved.requestedOverlap} exceeds the maximum ` +
        `${resolved.maxOverlap} for RAG_CHUNK_SIZE=${resolved.chunkSize} and has been ` +
        `reduced to ${resolved.overlap}. Above the cap the chunker's window advance ` +
        `collapses and ingest emits a run of near-duplicate chunks (#1185).`,
      {
        requestedOverlap: resolved.requestedOverlap,
        effectiveOverlap: resolved.overlap,
        chunkSize: resolved.chunkSize,
      },
    );
  }
  return { chunkSize: resolved.chunkSize, overlap: resolved.overlap };
}

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function clamp(n: number, min: number, max: number): number {
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function assertProjectId(id: string): void {
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new TypeError("projectId must be a non-empty string");
  }
}

let singleton: KnowledgeService | null = null;
let archiveHookWired = false;
let pendingEmit: ((event: KnowledgeEvent) => void) | null = null;

export function getKnowledgeService(): KnowledgeService {
  if (!singleton) {
    singleton = new KnowledgeService(pendingEmit ? { emit: pendingEmit } : {});
    if (!archiveHookWired) {
      onArchive((projectId) => singleton!.dropProject(projectId));
      archiveHookWired = true;
    }
  }
  return singleton;
}

/**
 * Wire the singleton's realtime emitter (called from `createServer` once the
 * Socket.IO instance is available). If the singleton already exists it gets
 * replaced with a new one carrying the emit hook so live ingest broadcasts
 * are not lost.
 */
export function configureKnowledgeService(deps: { emit: (event: KnowledgeEvent) => void }): void {
  pendingEmit = deps.emit;
  singleton = new KnowledgeService({ emit: deps.emit });
  if (!archiveHookWired) {
    onArchive((projectId) => singleton!.dropProject(projectId));
    archiveHookWired = true;
  }
}

/** Test seam — drop the singleton between tests. */
export function __resetKnowledgeServiceSingleton(): void {
  singleton = null;
  archiveHookWired = false;
  pendingEmit = null;
}
