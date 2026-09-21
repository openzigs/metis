/**
 * Epic #1156 / Issue #1160 — the document-retrieval harness that ACTUALLY RUNS
 * RETRIEVAL.
 *
 * ## What is real here, stated precisely
 *
 * The point of this file is that nothing about retrieval is imitated. Each arm:
 *
 *   1. writes a real `Document` row per corpus file into a THROWAWAY SQLite
 *      database created by `prisma db push`;
 *   2. calls the production {@link KnowledgeService.ingestDocument}, so chunking is
 *      the production {@link import("../../rag/chunker.js").chunkMarkdown} at this
 *      arm's `chunkOptions`, embedding is the production `Embedder`, quarantine +
 *      auto-approve run, and `KnowledgeChunk` rows and vectors are really written;
 *   3. queries through the production {@link KnowledgeService.search} — dense
 *      retrieval over a real {@link LocalVectorStore}, a real MiniSearch
 *      {@link BM25Index} lazily loaded from the `KnowledgeChunk` rows just written,
 *      reciprocal-rank fusion, the model-identity coverage filter, and the rerank
 *      stage — and scores what comes back.
 *
 * There is no `retrievedChunks` fixture anywhere in this path. That is the whole
 * difference from `rag:eval`, whose twenty fixtures carry canned retrieval scored
 * by a stub judge and would print identical numbers at every chunk size.
 *
 * ## What is stood in for, and why each is not a ranking component
 *
 *   - **The database is SQLite in a temp directory**, not the deployment's
 *     Postgres. `prisma db push` takes ~200 ms. Prisma is storage for chunk text
 *     and ACL columns here; it does no ranking.
 *   - **Storage is in-memory** ({@link corpusStorage}) rather than the filesystem or
 *     S3 backend. It serves the corpus bytes to `parseDocument` and is not
 *     reachable from the query path at all.
 *   - **One `Embedder` instance is shared across arms**, constructed and warmed by the
 *     CLI and passed explicitly into every arm's `KnowledgeService`. Letting it fall
 *     back to `getEmbedder()` would use a SECOND singleton whose lazy ONNX load lands
 *     inside the first arm's `reindexSeconds` — and that wall clock is one of the
 *     numbers this issue reports as a cost.
 *
 * ## The env-ordering trap
 *
 * `server/src/lib/prisma.ts` builds its driver adapter at MODULE LOAD from
 * `process.env.DATABASE_URL` (`const adapter = selectPrismaAdapter()`). So
 * `DATABASE_URL` must already point at the throwaway database before anything that
 * imports `prisma` is loaded — which is why {@link runChunkSweep} is reached
 * through a dynamic `import()` from `scripts/eval-doc-retrieval.ts` after that
 * variable is set. {@link assertThrowawayDatabase} enforces it rather than trusting
 * it: pointing this harness at a real database would write documents into it.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { StorageBackend, StoredBlob } from "../../documents/storage-backend.js";
import { BM25Index } from "../../rag/bm25-index.js";
import { chunkMarkdown } from "../../rag/chunker.js";
import type { Embedder } from "../../rag/embedder.js";
import { KnowledgeService } from "../../rag/knowledge-service.js";
import { LocalVectorStore } from "../../rag/vector-store.js";
import { boundDatabaseUrl, prisma, redactDatabaseUrl } from "../../prisma.js";
import { aggregate, scoreQuery, type QueryScore } from "../embed-retrieval/metrics.js";
import { alignChunksToSource, bestCoveringChunk, realisedOverlapChars } from "./chunk-alignment.js";
import {
  armOverlap,
  CHUNK_SIZE_ARMS,
  describeOverlapPlan,
  compareChunkArm,
  CONTROL_CHUNK_SIZE,
  DOC_EVAL_K,
  overlapArmsFor,
  type ChunkArmResult,
  type ChunkArmSpec,
  type ChunkSweepReport,
} from "./chunk-sweep.js";
import { loadDocRetrievalCorpus, type DocRetrievalCorpus } from "./corpus.js";
import {
  profileRerankBudget,
  RERANK_MODEL,
  type RerankBudgetProfile,
  type TokenCounter,
} from "./rerank-budget.js";

const SERVER_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);

/**
 * Refuse to run against anything but a throwaway SQLite file.
 *
 * This harness CREATES DOCUMENTS and DELETES CHUNKS. Run it against a developer's
 * `dev.db` — or worse, a deployment's Postgres — and it would silently corrupt
 * real project data. The guard is cheap and the failure it prevents is not
 * recoverable, so it is an assertion rather than a comment.
 */
export function assertThrowawayDatabase(databaseUrl: string | undefined, tmpRoot: string): void {
  if (!databaseUrl || !databaseUrl.startsWith("file:")) {
    throw new Error(
      `eval:doc-retrieval requires DATABASE_URL to be a throwaway SQLite file, got ` +
        `${databaseUrl ? JSON.stringify(databaseUrl.slice(0, 12) + "…") : "undefined"}. ` +
        `The harness writes Document rows and deletes KnowledgeChunk rows; it must never ` +
        `be pointed at a real database.`,
    );
  }
  const file = databaseUrl.slice("file:".length);
  if (!path.resolve(file).startsWith(path.resolve(tmpRoot) + path.sep)) {
    throw new Error(
      `eval:doc-retrieval requires DATABASE_URL to live under the run's temp directory ` +
        `(${tmpRoot}); got ${file}. Refusing to write to a database the harness does not own.`,
    );
  }
}

/**
 * Refuse to run when the Prisma client is bound to a DIFFERENT database than the
 * one the caller believes it owns (#1338).
 *
 * {@link assertThrowawayDatabase} checks a STRING the caller passes. That string
 * is the caller's intent, not the client's reality: `src/lib/prisma.ts` builds
 * its driver adapter once, at module load, so any import that reaches it before
 * `DATABASE_URL` is repointed binds the client to whatever was configured
 * first — typically a developer's `dev.db`. The first guard passes happily while
 * this harness creates a `User`, a `Project` and one `Document` per corpus file
 * in that real database.
 *
 * Found by wiring the answer-correctness generator (#1338): the CLI statically
 * imported `src/lib/ai/index.js`, which transitively loads `prisma.js`, so by
 * the time the generator set `DATABASE_URL` the adapter was already built. On
 * this machine it surfaced as `no such table: main.users`, which is only how it
 * fails when the developer's `dev.db` happens to be empty.
 */
export function assertPrismaOwnsDatabase(databaseUrl: string): void {
  if (boundDatabaseUrl !== databaseUrl) {
    throw new Error(
      `the Prisma client is bound to ${JSON.stringify(redactDatabaseUrl(boundDatabaseUrl))} but ` +
        `this run owns ${JSON.stringify(databaseUrl)}. Something imported src/lib/prisma.ts ` +
        `(directly or transitively — src/lib/ai/index.js does) before DATABASE_URL was set, so ` +
        `the adapter was built against the wrong database. Set DATABASE_URL before the first ` +
        `value import, and reach this harness through a dynamic import().`,
    );
  }
}

/**
 * An in-memory {@link StorageBackend} serving the corpus bytes.
 *
 * `ingestDocument` reads through this and hands the bytes to `parseDocument`; it is
 * not on the query path, so it cannot influence ranking.
 */
export function corpusStorage(bytesByPath: ReadonlyMap<string, Buffer>): StorageBackend {
  return {
    async write(input): Promise<StoredBlob> {
      const checksum = createHash("sha256").update(input.buffer).digest("hex");
      return {
        absolutePath: `mem://${checksum}`,
        storagePath: `mem://${checksum}`,
        checksum,
        sizeBytes: input.buffer.length,
        deduplicated: false,
      };
    },
    async read(storagePath: string): Promise<Buffer> {
      const buf = bytesByPath.get(storagePath);
      if (!buf) throw new Error(`corpusStorage: no blob at ${storagePath}`);
      return buf;
    },
    async remove(): Promise<void> {},
    async exists(storagePath: string): Promise<boolean> {
      return bytesByPath.has(storagePath);
    },
    async removeProject(): Promise<void> {},
  };
}

/** Shape of the child-process runner {@link pushSchema} uses; injectable for tests. */
export type ExecRunner = (file: string, args: readonly string[], opts: object) => unknown;

/** Create the throwaway SQLite schema. */
export function pushSchema(databaseUrl: string, run: ExecRunner = execFileSync): void {
  run(
    "npx",
    // `--skip-generate` is NOT a valid flag for `prisma db push` in this Prisma
    // version — it prints usage and exits non-zero. The URL is passed explicitly
    // as well as through the environment because `prisma.config.ts` otherwise
    // resolves the datasource itself.
    [
      "prisma",
      "db",
      "push",
      "--schema=prisma/schema.prisma",
      "--accept-data-loss",
      "--url",
      databaseUrl,
    ],
    { cwd: SERVER_ROOT, env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: "pipe" },
  );
}

/** Options {@link runChunkSweep} needs from its caller. */
export interface ChunkSweepOptions {
  corpusId?: string;
  /** The production embedder, constructed by the CLI so weights load once. */
  embedder: Embedder;
  /** Temp root the harness owns; the SQLite file and vector store live under it. */
  tmpRoot: string;
  seed?: number;
  resamples?: number;
  /** Progress line sink. */
  log?: (message: string) => void;
  /**
   * Creates the `Document` rows the arms ingest. Defaults to the real Prisma
   * writes; injected in tests so the sweep's ORCHESTRATION (arm loop, winner
   * choice, overlap arm, report assembly) is exercised without a database.
   */
  seedDocuments?: (
    corpus: DocRetrievalCorpus,
    storagePaths: ReadonlyMap<string, string>,
  ) => Promise<Map<string, string>>;
  /**
   * Loads the token counter for the cross-encoder budget profile. Defaults to the
   * reranker's real tokenizer, which is a Hugging Face fetch — so unit tests MUST
   * inject a stub. The repo gates download-bearing tests behind
   * `EMBEDDINGS_MODEL_DOWNLOAD_TESTS=1`, and `pnpm test` does not set it.
   */
  loadTokenCounter?: () => Promise<TokenCounter>;
}

/**
 * Seed the throwaway database with a project, an uploader and one `Document` per
 * corpus file, then return the document ids in corpus order.
 *
 * `autoApproveTrusted` is set so `ingestDocument` graduates chunks straight out of
 * quarantine — the alternative is measuring retrieval over an empty index.
 */
async function seedDocuments(
  corpus: DocRetrievalCorpus,
  storagePaths: ReadonlyMap<string, string>,
): Promise<Map<string, string>> {
  const userId = `eval-user-${randomUUID()}`;
  await prisma.user.create({
    data: {
      id: userId,
      username: userId,
      displayName: "doc-retrieval eval",
      email: `${userId}@eval.invalid`,
    },
  });
  await prisma.project.create({
    data: {
      id: corpus.projectId,
      name: corpus.id,
      slug: corpus.id,
      createdById: userId,
      autoApproveTrustedSources: true,
    },
  });

  const ids = new Map<string, string>();
  for (const doc of corpus.docs) {
    const id = `eval-doc-${createHash("sha1").update(doc.id).digest("hex").slice(0, 24)}`;
    await prisma.document.create({
      data: {
        id,
        projectId: corpus.projectId,
        filename: doc.id,
        mimeType: "text/markdown",
        sizeBytes: Buffer.byteLength(doc.text, "utf8"),
        storagePath: storagePaths.get(doc.id) ?? "",
        checksum: createHash("sha256").update(doc.text).digest("hex"),
        status: "pending",
        uploadedById: userId,
        autoApproveTrusted: true,
      },
    });
    ids.set(doc.id, id);
  }
  return ids;
}

/** The relevant chunk for one query at one arm, or `null` when the span was dropped. */
export type RelevantChunk = { text: string; coverage: number } | null;

/**
 * Stand-in "right answer" for a query whose span the chunker dropped.
 *
 * `recallAtK` rightly refuses an empty relevant set ("a query with no right answer
 * is a corpus bug", `metrics.ts:114`) — but this query DOES have a right answer;
 * the index simply does not contain it. A sentinel that no chunk text can ever
 * equal (chunk bodies are trimmed markdown, so none begins with a NUL) makes every
 * metric score a legitimate 0 while keeping the relevant-set size at 1, so the
 * arm's macro-average stays comparable with the others.
 */
export const UNRETRIEVABLE_SENTINEL_PREFIX = "\u0000span-dropped-by-chunker:";

/**
 * The relevant chunk for each query at this arm, derived from the FIXED answer
 * span — never from a chunk index. See `chunk-alignment.ts` for why the
 * best-covering chunk is the right unit and why the chunker's own offsets are not
 * trusted.
 *
 * ## `null` means the production chunker DROPPED the answer span — zero since #1178
 *
 * `chunkMarkdown` did not tile its input until #1178. `sliceSection` cut at
 * `findBoundary(...)` but then advanced with
 * `cursor = Math.max(cursor + stride, sliceEnd - overlap)`, and since
 * `sliceEnd - overlap <= cursor + stride` always holds, the cursor advanced a
 * **full stride** even when the boundary search cut far short of it. Everything
 * between the cut and the next cursor was never emitted.
 *
 * Measured on this corpus at the SHIPPED 2048/256, 206 of 4,773 substantive lines
 * were absent from every chunk, and the arms indexed only 94.1% / 85.6% / 80.4% of
 * the corpus's characters at 2048 / 1024 / 768 — which is what confounded #1160's
 * sweep. It was worst on tables and code fences, which is most of METIS's
 * operational documentation.
 *
 * Since the fix the window resumes at the cut, every arm indexes 99.8%, and **no
 * answer span is dropped at any arm.** This function keeps returning `null` rather
 * than throwing because that is still the correct response to a genuinely
 * unretrievable span; a `null` today means the tiling property has regressed.
 *
 * This is a pre-existing production defect, not something the sweep introduced,
 * and it is deliberately NOT fixed here: #1160 is a chunk-size experiment, and
 * changing the chunker's output in the same PR would make neither the fix nor the
 * sweep attributable (#1156's #931-vs-#936 rule). It is reported and filed as
 * #1178 instead.
 *
 * So an uncovered span is scored as a genuine miss — retrieval cannot return
 * content that is not in the index, and pretending otherwise would flatter the
 * arm. Because that conflates index coverage with ranking, the sweep ALSO reports
 * the subset covered at every arm, so the two mechanisms stay separable.
 */
export function relevantChunksForArm(
  corpus: DocRetrievalCorpus,
  spec: ChunkArmSpec,
): Map<string, RelevantChunk> {
  const out = new Map<string, RelevantChunk>();
  const alignedByDoc = new Map<string, ReturnType<typeof alignChunksToSource>>();
  for (const doc of corpus.docs) {
    const chunks = chunkMarkdown(doc.text, { chunkSize: spec.chunkSize, overlap: spec.overlap });
    alignedByDoc.set(doc.id, alignChunksToSource(doc.text, chunks));
  }
  for (const q of corpus.queries) {
    const aligned = alignedByDoc.get(q.doc);
    if (!aligned) throw new Error(`Query ${q.id} names unknown document ${q.doc}`);
    const best = bestCoveringChunk(aligned, q.spanStart, q.spanEnd);
    out.set(q.id, best ? { text: aligned[best.index].text, coverage: best.fraction } : null);
  }
  return out;
}

/** Query ids whose answer span survives chunking at this arm. */
export function coveredQueryIds(corpus: DocRetrievalCorpus, spec: ChunkArmSpec): string[] {
  const rel = relevantChunksForArm(corpus, spec);
  return corpus.queries.filter((q) => rel.get(q.id) != null).map((q) => q.id);
}

/** The production service for one arm — the real `KnowledgeService`, real store. */
function defaultArmService(
  spec: ChunkArmSpec,
  storeRoot: string,
  bytes: Map<string, Buffer>,
  embedder: Embedder,
): ArmRetrieval {
  return new KnowledgeService({
    // The CLI's warmed instance, NOT `getEmbedder()`'s separate singleton — passing
    // no embedder here would leave a second lazy ONNX load inside the FIRST arm's
    // `reindexSeconds`, silently inflating the one number this issue reports as a cost.
    embedder,
    vectorStore: new LocalVectorStore({ root: storeRoot }),
    storage: corpusStorage(bytes),
    // A FRESH BM25 index per arm. The singleton caches a project's MiniSearch
    // index after its first lazy load, so reusing it would score every arm after
    // the first against the FIRST arm's chunks — silently reporting no effect.
    bm25: new BM25Index(),
    chunkOptions: { chunkSize: spec.chunkSize, overlap: spec.overlap },
  }) as unknown as ArmRetrieval;
}

async function defaultResetIndex(projectId: string): Promise<void> {
  await prisma.knowledgeChunk.deleteMany({ where: { projectId } });
  await prisma.quarantineChunk.deleteMany({ where: { projectId } });
}

async function defaultCountPersisted(projectId: string): Promise<number> {
  return prisma.knowledgeChunk.count({ where: { projectId } });
}

/**
 * The two operations {@link runChunkArm} needs from a `KnowledgeService`.
 *
 * Declared as an interface so the arm loop's invariants — fresh index per arm,
 * persisted-count agreement, the dropped-span sentinel — can be tested without a
 * database. The production factory below builds the REAL service; nothing about
 * the measured run goes through a substitute.
 */
export interface ArmRetrieval {
  ingestDocument(
    documentId: string,
  ): Promise<{ status: string; chunkCount: number; errorMessage?: string }>;
  search(
    projectId: string,
    query: string,
    opts: { k: number },
  ): Promise<{ hits: { text: string }[] }>;
}

/** Extra collaborators {@link runChunkArm} takes, all defaulted to production. */
export interface ArmDeps {
  storagePaths: ReadonlyMap<string, string>;
  docIds: ReadonlyMap<string, string>;
  /** Builds the service for this arm. Defaults to the real `KnowledgeService`. */
  makeService?: (
    spec: ChunkArmSpec,
    storeRoot: string,
    bytes: Map<string, Buffer>,
    embedder: Embedder,
  ) => ArmRetrieval;
  /** Clears the previous arm's rows. Defaults to the real Prisma deletes. */
  resetIndex?: (projectId: string) => Promise<void>;
  /** Counts persisted chunks for the agreement check. Defaults to Prisma. */
  countPersisted?: (projectId: string) => Promise<number>;
}

/**
 * Ingest every corpus document through the production `ingestDocument`, and
 * return how many chunks were written.
 *
 * Shared by {@link runChunkArm} and {@link openCorpusRetrieval} so the sweep and
 * the answer run index the corpus through exactly ONE code path. A partial
 * ingest is fatal: an arm — or an answer — measured against a half-built index
 * is measuring the accident, not the system.
 */
async function ingestCorpus(
  service: ArmRetrieval,
  corpus: DocRetrievalCorpus,
  docIds: ReadonlyMap<string, string>,
  label: string,
): Promise<number> {
  let chunkCount = 0;
  for (const doc of corpus.docs) {
    const documentId = docIds.get(doc.id);
    if (!documentId) throw new Error(`No Document row seeded for ${doc.id}`);
    const result = await service.ingestDocument(documentId);
    if (result.status !== "ready") {
      throw new Error(
        `Ingest of ${doc.id} at ${label} ended ${result.status}: ${result.errorMessage}`,
      );
    }
    chunkCount += result.chunkCount;
  }
  return chunkCount;
}

/** A corpus indexed once and queryable — the generated side's retrieval (#1338). */
export interface CorpusRetrievalSession {
  projectId: string;
  /** Chunks the production ingest actually wrote. */
  chunkCount: number;
  /** The chunk texts the production `KnowledgeService.search` returns. */
  search: (question: string, k: number) => Promise<string[]>;
}

/** What {@link openCorpusRetrieval} needs; every collaborator defaults to production. */
export interface CorpusRetrievalOptions {
  tmpRoot: string;
  embedder: Embedder;
  /** Defaults to the sweep's CONTROL arm, i.e. the shipped chunk settings. */
  spec?: ChunkArmSpec;
  log?: (message: string) => void;
  seedDocuments?: (
    corpus: DocRetrievalCorpus,
    storagePaths: ReadonlyMap<string, string>,
  ) => Promise<Map<string, string>>;
  makeService?: ArmDeps["makeService"];
}

/**
 * Index the corpus ONCE and hand back its production search path (#1338).
 *
 * This is the same seeding, the same `KnowledgeService`, the same chunker and
 * the same `search` the chunk sweep measures — assembled here without the
 * arm loop, the relevance scoring or the A/B comparison, none of which an
 * answer run needs. It is deliberately NOT a second harness: `seedDocuments`,
 * `defaultArmService` and {@link ingestCorpus} are the sweep's own.
 *
 * The default spec is the CONTROL arm rather than the sweep's winner, because an
 * answer-correctness number has to describe the chunking METIS actually ships.
 */
export async function openCorpusRetrieval(
  corpus: DocRetrievalCorpus,
  opts: CorpusRetrievalOptions,
): Promise<CorpusRetrievalSession> {
  const log = opts.log ?? ((): void => {});
  const spec = opts.spec ?? CHUNK_SIZE_ARMS.find((a) => a.control);
  if (!spec) throw new Error("CHUNK_SIZE_ARMS declares no control arm");

  const storeRoot = path.join(opts.tmpRoot, `answers-${spec.id}`);
  await fs.mkdir(storeRoot, { recursive: true });

  const storagePaths = new Map(corpus.docs.map((d) => [d.id, `mem://${d.id}`]));
  const bytes = new Map<string, Buffer>();
  for (const doc of corpus.docs) {
    bytes.set(storagePaths.get(doc.id) ?? "", Buffer.from(doc.text, "utf8"));
  }

  const docIds = await (opts.seedDocuments ?? seedDocuments)(corpus, storagePaths);
  const service = (opts.makeService ?? defaultArmService)(spec, storeRoot, bytes, opts.embedder);
  const chunkCount = await ingestCorpus(service, corpus, docIds, spec.id);
  log(`  indexed ${corpus.docs.length} document(s) into ${chunkCount} chunks at ${spec.id}`);

  return {
    projectId: corpus.projectId,
    chunkCount,
    search: async (question, k) =>
      (await service.search(corpus.projectId, question, { k })).hits.map((h) => h.text),
  };
}

/** Run one arm end-to-end and score it. */
export async function runChunkArm(
  corpus: DocRetrievalCorpus,
  spec: ChunkArmSpec,
  opts: ChunkSweepOptions & ArmDeps,
): Promise<ChunkArmResult> {
  const log = opts.log ?? ((): void => {});
  const storeRoot = path.join(opts.tmpRoot, `vectors-${spec.id}`);
  await fs.mkdir(storeRoot, { recursive: true });

  const bytes = new Map<string, Buffer>();
  for (const doc of corpus.docs) {
    bytes.set(opts.storagePaths.get(doc.id) ?? "", Buffer.from(doc.text, "utf8"));
  }

  const service = (opts.makeService ?? defaultArmService)(spec, storeRoot, bytes, opts.embedder);

  // Clear the previous arm's chunks so the lazy BM25 load and the coverage filter
  // see this arm's index alone.
  await (opts.resetIndex ?? defaultResetIndex)(corpus.projectId);

  const started = Date.now();
  const chunkCount = await ingestCorpus(service, corpus, opts.docIds, spec.id);
  const reindexSeconds = (Date.now() - started) / 1000;
  log(`  ${spec.id}: ${chunkCount} chunks in ${reindexSeconds.toFixed(1)}s`);

  const persisted = await (opts.countPersisted ?? defaultCountPersisted)(corpus.projectId);
  if (persisted !== chunkCount) {
    throw new Error(
      `${spec.id}: ingest reported ${chunkCount} chunks but ${persisted} were persisted — ` +
        `the harness is not measuring what production wrote`,
    );
  }

  // The check above catches a partial WRITE. It does not check the assumption the
  // ground truth actually rests on: that `relevantChunksForArm`'s locally recomputed
  // `chunkMarkdown(doc.text, …)` produces the same chunks the ingest path wrote.
  // Ingest goes through `parseDocument` first, so if that ever normalises the text
  // (frontmatter, CRLF, entity handling) the derived relevant-chunk TEXT would stop
  // matching any indexed chunk and every arm would silently deflate to zero without
  // a single error. They agree today; this is the guard against future drift.
  const localTotal = corpus.docs.reduce(
    (n, d) =>
      n + chunkMarkdown(d.text, { chunkSize: spec.chunkSize, overlap: spec.overlap }).length,
    0,
  );
  if (localTotal !== chunkCount) {
    throw new Error(
      `${spec.id}: the harness chunked the corpus into ${localTotal} chunks but ingest wrote ` +
        `${chunkCount} — the ground truth is derived from a DIFFERENT chunking than the one ` +
        `being searched, so every relevance judgement is invalid. Most likely cause: the ` +
        `ingest path now normalises document text before chunking.`,
    );
  }

  const relevant = relevantChunksForArm(corpus, spec);
  const perQuery: QueryScore[] = [];
  const uncoveredQueryIds: string[] = [];
  const spanCoverage: Record<string, number> = {};
  let coverageSum = 0;
  for (const q of corpus.queries) {
    const target = relevant.get(q.id) ?? null;
    spanCoverage[q.id] = target?.coverage ?? 0;
    if (target === null) uncoveredQueryIds.push(q.id);
    else coverageSum += target.coverage;
    const { hits } = await service.search(corpus.projectId, q.question, { k: DOC_EVAL_K });
    // Rank by chunk TEXT, which is the identity the span-derived ground truth has.
    // Chunk ids are database rows regenerated per arm and are not comparable.
    // An uncovered span gets an UNRETRIEVABLE sentinel as its right answer, so every
    // metric scores a legitimate 0 — the honest outcome, because the answer is
    // genuinely absent from the index.
    perQuery.push(
      scoreQuery(
        q.id,
        hits.map((h) => h.text),
        [target === null ? `${UNRETRIEVABLE_SENTINEL_PREFIX}${q.id}` : target.text],
      ),
    );
  }
  if (uncoveredQueryIds.length > 0) {
    log(
      `  ${spec.id}: ${uncoveredQueryIds.length} answer span(s) DROPPED by the chunker ` +
        `(${uncoveredQueryIds.join(", ")}) — scored 0; see relevantChunksForArm's header`,
    );
  }

  const overlap = measureOverlapDelivery(corpus, spec);

  return {
    spec,
    chunkCount,
    reindexSeconds,
    perQuery,
    metrics: aggregate(perQuery),
    meanSpanCoverage: corpus.queries.length === 0 ? 0 : coverageSum / corpus.queries.length,
    spanCoverage,
    realisedOverlapChars: overlap.realised,
    expectedOverlapChars: overlap.expected,
    uncoveredQueryIds,
    // Filled in by the sweep once the control's chunking is known.
    sensitiveQueryIds: [],
  };
}

/**
 * Realised vs configured overlap across the corpus at one arm.
 *
 * "Expected if tiled" is `overlap × (within-section chunk boundaries)`: a correctly
 * tiled window shares `overlap` characters with its predecessor once per boundary
 * INSIDE a section, and a section's first chunk has no predecessor to share with.
 *
 * **Counting a section transition as a boundary was itself a reporting defect, fixed
 * with #1178.** The old count — "a chunk that begins after its predecessor's start is
 * a continuation" — is true of a new section's first chunk too, since that starts
 * later in the source than the previous section's last chunk did. Most METIS sections
 * fit in one chunk, so on the committed corpus at 2048/256 it counted **466
 * boundaries where only 51 are continuations**, inflating the denominator ninefold.
 *
 * That inflation is the origin of the "~98% of the configured overlap is never
 * delivered" figure reported on #1178. With the denominator corrected the honest
 * before-fix number is **80.8% undelivered, not 98%** — the pre-#1178 chunker
 * delivered 19.2% of its configured overlap at 2048/256, not 2.0%. Both readings said
 * "broken", which is exactly why the reporting defect stayed invisible: it only starts
 * to matter once the ratio is supposed to be near 1. After the chunker fix the shipped
 * arm delivers **99.1%** (98.0–99.5% across the four arms).
 *
 * The chunk's own `headings` trail identifies a continuation exactly: the window
 * restarts at every heading, and `splitSections` flushes a section per heading line,
 * so consecutive chunks sharing a trail are chunks of one section. Checked against a
 * ground truth of `chunks − sections` computed by replaying `splitSections`' flush
 * rule, the trail comparison agreed **exactly at all four arms, before and after the
 * fix** (51/235/393/20 after; 49/205/338/20 before). Its one residual blind spot is
 * two CONSECUTIVE sections carrying an identical heading trail — a repeated `## Setup`
 * under the same parent — which does not occur in this corpus.
 *
 * **Meaningful on real prose only.** It inherits `alignChunksToSource`'s repetitive-input
 * limit: a document of byte-identical repeated lines resolves every chunk to the
 * earliest occurrence, which bunches the ranges and can report realised overlap ABOVE
 * the tiled expectation. The committed corpus is real documentation and behaves; a
 * synthetic fixture built from one repeated sentence does not.
 *
 * ## The denominator is the EFFECTIVE overlap, not the configured one (#1183)
 *
 * `chunkMarkdown` caps carry-over at `maxOverlapFor(chunkSize)` ≈ `chunkSize / 4`
 * (#1185). Multiplying the boundary count by `spec.overlap` therefore over-states what
 * a tiled window could have delivered whenever the arm is clamped — at 768/256 the cap
 * is 192, so a quarter of the apparent shortfall would be charged to #1178's tiling
 * when it is really the clamp. Delivery still measured 0.74 there, above
 * `OVERLAP_INTERPRETABLE_FRACTION` (0.5), so the READABLE guard did NOT misfire and the
 * error was invisible.
 *
 * **It does not only understate.** `renderOverlapDelivery` takes the WORST arm, so one
 * clamped arm decides the whole run's verdict: measured on the committed corpus the old
 * denominator reads 0.496 at 1024/512 and 0.371 at 768/512, both BELOW the bar. There
 * the bug would have stamped UNINTERPRETABLE across a sweep whose chunker delivered 99%
 * — discarding a valid measurement rather than flattering an invalid one. Reading this
 * function as "the clamp made delivery look worse than it was" gets the risk backwards
 * in half the range. `armOverlap` resolves the same way `chunkMarkdown` does.
 */
export function measureOverlapDelivery(
  corpus: DocRetrievalCorpus,
  spec: ChunkArmSpec,
): { realised: number; expected: number } {
  const effectiveOverlap = armOverlap(spec.chunkSize, spec.overlap).effective;
  let realised = 0;
  let expected = 0;
  for (const doc of corpus.docs) {
    const chunks = chunkMarkdown(doc.text, { chunkSize: spec.chunkSize, overlap: spec.overlap });
    const aligned = alignChunksToSource(doc.text, chunks);
    realised += realisedOverlapChars(aligned);
    let boundaries = 0;
    for (let i = 1; i < chunks.length; i += 1) {
      const prev = chunks[i - 1];
      const next = chunks[i];
      const sameSection =
        prev.headings.length === next.headings.length &&
        next.headings.every((h, j) => h === prev.headings[j]);
      if (sameSection && next.startOffset > prev.startOffset) boundaries += 1;
    }
    expected += boundaries * effectiveOverlap;
  }
  return { realised, expected };
}

/**
 * Query ids whose best-covering chunk TEXT differs between two arms.
 *
 * These are the only queries whose score CAN move. A query whose answer span sits
 * in a section shorter than both arms' chunk size gets a byte-identical chunk at
 * both, so its delta is zero by construction — see `chunk-sweep.ts`'s header for
 * why that subset is reported separately rather than silently included or dropped.
 */
export function armSensitiveQueryIds(
  corpus: DocRetrievalCorpus,
  control: ChunkArmSpec,
  arm: ChunkArmSpec,
): string[] {
  const a = relevantChunksForArm(corpus, control);
  const b = relevantChunksForArm(corpus, arm);
  return corpus.queries
    .filter((q) => (a.get(q.id) ?? null)?.text !== (b.get(q.id) ?? null)?.text)
    .map((q) => q.id);
}

/**
 * Make "this harness reaches no network from `pnpm test`" an INVARIANT, not a habit.
 *
 * The `catch` below swallows a tokenizer load failure and returns an empty profile —
 * deliberately, because a missing side-measurement must not fail a sweep whose primary
 * numbers are already in hand. The cost of that kindness is that a future test calling
 * {@link runChunkSweep} without `loadTokenCounter` would reach
 * `https://huggingface.co` from inside the default gate and still pass green unless it
 * happened to assert on `rerankBudget`. Convention would not catch it; this does.
 *
 * Thrown BEFORE the try block on purpose, so the catch cannot degrade it into a
 * skipped profile. `EMBEDDINGS_MODEL_DOWNLOAD_TESTS=1` is the repo's existing escape
 * hatch for a test that genuinely means to download.
 */
export function assertTokenCounterInjectedUnderTest(
  loadCounter: () => Promise<TokenCounter>,
): void {
  const underTest = process.env.VITEST === "true" || process.env.NODE_ENV === "test";
  if (!underTest) return;
  if (process.env.EMBEDDINGS_MODEL_DOWNLOAD_TESTS === "1") return;
  if (loadCounter !== loadRerankTokenCounter) return;
  throw new Error(
    "profileArmsAgainstRerankBudget was called under test without a `loadTokenCounter` " +
      "seam, which would fetch the cross-encoder tokenizer from Hugging Face inside " +
      "`pnpm test`. Inject a stub counter, or set EMBEDDINGS_MODEL_DOWNLOAD_TESTS=1 if " +
      "the download is the point of the test.",
  );
}

/**
 * Load the reranker's OWN tokenizer, so the profile counts what the model sees.
 *
 * Exported ONLY so {@link assertTokenCounterInjectedUnderTest} can be tested against
 * the real reference it guards — never called from a test.
 */
export async function loadRerankTokenCounter(): Promise<TokenCounter> {
  const { AutoTokenizer } = await import("@huggingface/transformers");
  const tokenizer = await AutoTokenizer.from_pretrained(RERANK_MODEL);
  return (text: string): number =>
    (tokenizer(text, { add_special_tokens: false }).input_ids.dims as number[])[1];
}

/**
 * Profile every arm's chunks against the cross-encoder's 512-token pair budget —
 * the question #1158's review routed here.
 *
 * Uses the reranker's OWN tokenizer rather than a chars-per-token estimate, because
 * the whole point is what the model actually sees. Degrades to an empty profile if
 * the tokenizer cannot be loaded: a missing side-measurement must not fail a sweep
 * whose primary numbers are already in hand.
 */
export async function profileArmsAgainstRerankBudget(
  corpus: DocRetrievalCorpus,
  log: (m: string) => void,
  loadCounter: () => Promise<TokenCounter> = loadRerankTokenCounter,
): Promise<RerankBudgetProfile[]> {
  assertTokenCounterInjectedUnderTest(loadCounter);
  let countTokens: TokenCounter;
  let queryTokens: number;
  try {
    countTokens = await loadCounter();
    // AWAITED, not cast. `TokenCounter` may return a Promise (`rerank-budget.ts:41`),
    // and `as number` on an unawaited call silently produces NaN for `queryTokens`,
    // hence NaN for `passageBudget`, hence `t > NaN === false` for every chunk — a
    // clean-looking table reporting 0% over budget and 100% surviving, which is
    // precisely the claim this profile exists to make. Failing that way is worse than
    // not measuring at all.
    const queryLengths: number[] = [];
    for (const q of corpus.queries) queryLengths.push(await countTokens(q.question));
    queryTokens = Math.round(queryLengths.reduce((a, b) => a + b, 0) / (queryLengths.length || 1));
  } catch (err) {
    log(`  cross-encoder budget profile skipped: ${(err as Error).message}`);
    return [];
  }

  const profiles: RerankBudgetProfile[] = [];
  for (const spec of CHUNK_SIZE_ARMS) {
    const texts = corpus.docs.flatMap((d) =>
      chunkMarkdown(d.text, { chunkSize: spec.chunkSize, overlap: spec.overlap }).map(
        (c) => c.text,
      ),
    );
    profiles.push(await profileRerankBudget(spec.chunkSize, texts, countTokens, queryTokens));
  }
  return profiles.sort((a, b) => a.chunkSize - b.chunkSize);
}

/**
 * The arm with the best nDCG@10 — the size question's answer, reported in the log.
 *
 * It is deliberately NOT where the overlap ladder runs: every arm is paired against
 * the 2048/256 control, so an overlap arm at some other size would carry a size
 * difference too (#1183). See {@link runChunkSweep}.
 *
 * Ties keep the EARLIER arm, which puts the control first when nothing beats it:
 * the expected outcome, and the one that must not be reported as a change.
 */
export function pickWinningArm(results: readonly ChunkArmResult[]): ChunkArmResult {
  if (results.length === 0) throw new Error("pickWinningArm: no arms were run");
  return results.reduce((a, b) =>
    (b.metrics.ndcgAtK[DOC_EVAL_K] ?? 0) > (a.metrics.ndcgAtK[DOC_EVAL_K] ?? 0) ? b : a,
  );
}

/** Run the whole sweep: four sizes, then the overlap ladder at the CONTROL size. */
export async function runChunkSweep(opts: ChunkSweepOptions): Promise<ChunkSweepReport> {
  const log = opts.log ?? ((): void => {});
  const corpus = await loadDocRetrievalCorpus(opts.corpusId);
  log(
    `Corpus ${corpus.id}: ${corpus.docs.length} documents, ${corpus.queries.length} queries, ` +
      `snapshot ${corpus.snapshotCommit}`,
  );

  const storagePaths = new Map(corpus.docs.map((d) => [d.id, `mem://${d.id}`]));
  const docIds = await (opts.seedDocuments ?? seedDocuments)(corpus, storagePaths);
  const shared = { ...opts, storagePaths, docIds };

  const controlSpec = CHUNK_SIZE_ARMS.find((a) => a.control);
  if (!controlSpec) throw new Error("CHUNK_SIZE_ARMS declares no control arm");

  const results = new Map<string, ChunkArmResult>();
  for (const spec of CHUNK_SIZE_ARMS) {
    results.set(spec.id, await runChunkArm(corpus, spec, shared));
  }
  const control = results.get(controlSpec.id);
  if (!control) throw new Error("control arm did not run");

  const comparisons = CHUNK_SIZE_ARMS.filter((s) => !s.control).map((spec) => {
    const arm = results.get(spec.id);
    if (!arm) throw new Error(`arm ${spec.id} did not run`);
    arm.sensitiveQueryIds = armSensitiveQueryIds(corpus, controlSpec, spec);
    return compareChunkArm(control, arm, opts);
  });

  // Reported for the size question, and deliberately NOT where the overlap arms run.
  const best = pickWinningArm([...results.values()]);
  log(`Winning size by nDCG@${DOC_EVAL_K}: ${best.spec.chunkSize} (${best.spec.id})`);

  // The overlap ladder runs at the CONTROL's size, not the winning one. Every arm is
  // paired against the 2048/256 control, so an overlap arm at another size would move
  // size and overlap together — the confound #1183 exists to remove.
  const overlapPlan = overlapArmsFor(controlSpec.chunkSize);
  log(describeOverlapPlan(overlapPlan));

  const overlapComparisons = [];
  for (const spec of overlapPlan.arms) {
    const arm = await runChunkArm(corpus, spec, shared);
    arm.sensitiveQueryIds = armSensitiveQueryIds(corpus, controlSpec, spec);
    overlapComparisons.push(compareChunkArm(control, arm, opts));
  }

  const rerankBudget = await profileArmsAgainstRerankBudget(corpus, log, opts.loadTokenCounter);

  return {
    corpusId: corpus.id,
    snapshotCommit: corpus.snapshotCommit,
    queryCount: corpus.queries.length,
    docCount: corpus.docs.length,
    corpusChars: corpus.docs.reduce((n, d) => n + d.text.length, 0),
    embeddingModel: opts.embedder.model,
    control,
    rerankBudget,
    comparisons,
    overlapComparisons,
    overlapPlan,
    generatedAt: new Date().toISOString(),
  };
}

/** The control chunk size the sweep is defined against, re-exported for the CLI. */
export { CONTROL_CHUNK_SIZE };

/** Temp root factory — one directory per run, removed by the CLI. */
export async function makeTmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "eval1160-"));
}
