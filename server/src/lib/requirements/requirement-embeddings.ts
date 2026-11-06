/**
 * Issue #1835 (epic #1828) — requirements in the vector store.
 *
 * Each live requirement of a project (title, body and acceptance criteria) is
 * embedded into the project's own vector namespace, `<projectId>__requirements`,
 * and kept in step with every edit, version bump, delete and analysis re-run.
 * Duplicate detection (#1837) and chat's semantic `list_requirements` (#1841)
 * read it through {@link findNearestRequirements}.
 *
 * ## One reconcile instead of a hook per writer
 *
 * Requirements are written from at least six places (analysis synthesis and
 * re-runs, promotion, the withheld-replacement apply, discussion promotion, the
 * importers and the edit routes), and a re-run deletes and RECREATES its rows,
 * so ids are not stable. Hooking each writer would miss one. Instead
 * {@link syncRequirementEmbeddings} compares the project's current requirements
 * with what is embedded, embeds what is new or changed and deletes the vectors
 * of requirements that no longer exist. Writers only ENQUEUE it (debounced, see
 * {@link enqueueRequirementEmbeddingSync}); every query RUNS it first, so a read
 * can never see an index older than the requirements it is asked about.
 *
 * ## Where the data lives
 *
 * Vectors go in the shared {@link VectorStore} (LanceDB, local JSON or pgvector),
 * as code-symbol vectors do (`symbol-embedding-service.ts`): a `vector(N)`
 * column's width comes from the configured embedder at runtime, which a static
 * migration cannot express. The `RequirementEmbedding` row holds the content
 * hash and the model tag the reconcile compares. The hash covers the model, so
 * an embedder change re-embeds every requirement.
 *
 * ## Scoping
 *
 * The namespace IS the project: a query reads only `<projectId>__requirements`,
 * and every hit is re-read from the database filtered on the project AND the id
 * AND `deletedAt: null`, so a stale vector can never surface a requirement that
 * was deleted, soft-deleted or moved.
 */
import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { parseAcceptanceCriteria } from "@metis/shared";
import { prisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";
import { getEmbedder } from "../rag/embedder.js";
import { MAX_EMBED_TEXTS_PER_REQUEST } from "../rag/embed-model-config.js";
import { getVectorStore, type VectorRow, type VectorStore } from "../rag/vector-store.js";
import type { EmbedService } from "../code-graph/symbol-embeddings.js";

const log = createChildLogger("requirement-embeddings");

/** The vector namespace holding one project's requirement vectors. */
export function requirementVectorsId(projectId: string): string {
  return `${projectId}__requirements`;
}

/** The Prisma surface the reconcile reads and writes. */
export type RequirementEmbeddingDb = Pick<PrismaClient, "requirement" | "requirementEmbedding">;

export interface RequirementEmbeddingDeps {
  store?: VectorStore;
  embedService?: EmbedService;
  /** The model id vectors are tagged with and filtered by. Defaults to the active embedder's. */
  model?: () => string;
  db?: RequirementEmbeddingDb;
}

type ResolvedDeps = Required<RequirementEmbeddingDeps>;

function resolveDeps(deps: RequirementEmbeddingDeps = {}): ResolvedDeps {
  return {
    store: deps.store ?? getVectorStore(),
    // The singleton, as for symbols: index side and query side must be the same embedder.
    embedService: deps.embedService ?? getEmbedder(),
    model: deps.model ?? ((): string => getEmbedder().model),
    db: deps.db ?? prisma,
  };
}

/** The fields of a requirement that are embedded. */
export interface EmbeddableRequirement {
  title: string;
  body: string;
  /** The stored JSON array of criteria. */
  acceptanceCriteria: string;
}

/**
 * The exact text a requirement is embedded from. The query side embeds draft
 * text through the same function, so the two are comparable.
 */
export function formatRequirementForEmbedding(req: EmbeddableRequirement): string {
  const criteria = parseAcceptanceCriteria(req.acceptanceCriteria);
  const parts = [req.title.trim(), req.body.trim()];
  if (criteria.length > 0) {
    parts.push(`Acceptance criteria:\n${criteria.map((c) => `- ${c}`).join("\n")}`);
  }
  return parts.filter((p) => p.length > 0).join("\n\n");
}

/** The reconcile's skip key: the model and the text, hashed together. */
export function requirementContentHash(model: string, text: string): string {
  return createHash("sha256").update(model).update("\n").update(text).digest("hex");
}

export interface RequirementSyncResult {
  projectId: string;
  /** Requirements embedded (new or changed) by this run. */
  embedded: number;
  /** Requirements whose vector was already current. */
  unchanged: number;
  /** Vectors deleted because their requirement is gone or soft-deleted. */
  deleted: number;
}

/** In-process serialisation: one reconcile per project at a time. */
const chains = new Map<string, Promise<unknown>>();

/**
 * Bring `<projectId>__requirements` in line with the project's live requirements.
 *
 * Idempotent: an unchanged requirement is not re-embedded (its hash matches and
 * its vector exists at the active model). Calls for one project are serialised in
 * this process; two replicas reconciling at once write the same rows, and a vector
 * one deletes as an orphan of its snapshot is re-embedded by the next reconcile
 * (its vector is missing), so the race costs work, never a wrong answer.
 */
export function syncRequirementEmbeddings(
  projectId: string,
  deps: RequirementEmbeddingDeps = {},
): Promise<RequirementSyncResult> {
  const previous = chains.get(projectId) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(() => runSync(projectId, resolveDeps(deps)));
  chains.set(projectId, run);
  void run
    .finally(() => {
      if (chains.get(projectId) === run) chains.delete(projectId);
    })
    .catch(() => undefined);
  return run;
}

async function runSync(projectId: string, deps: ResolvedDeps): Promise<RequirementSyncResult> {
  const { store, embedService, db } = deps;
  const activeModel = deps.model();
  const ns = requirementVectorsId(projectId);

  const requirements = await db.requirement.findMany({
    where: { projectId, deletedAt: null },
    select: { id: true, title: true, body: true, acceptanceCriteria: true },
    orderBy: { id: "asc" },
  });
  const current = new Map(
    requirements.map((r) => {
      const text = formatRequirementForEmbedding(r);
      return [r.id, { text, hash: requirementContentHash(activeModel, text) }] as const;
    }),
  );

  let refs = await store.listChunkRefs(ns).catch(() => []);
  // A row from another model generation may be another WIDTH, which a Lance table
  // cannot hold beside the new one. A project's requirements are few (hundreds),
  // so the whole namespace is rebuilt rather than migrated in place.
  if (refs.some((r) => r.embeddingModel !== activeModel)) {
    log.info("requirement vectors belong to another model; rebuilding", { projectId, activeModel });
    await store.dropTable(ns);
    refs = [];
  }
  const live = new Set(refs.map((r) => r.chunkId));

  const recorded = await db.requirementEmbedding.findMany({
    where: { projectId },
    select: { requirementId: true, contentHash: true },
  });
  const recordedHash = new Map(recorded.map((r) => [r.requirementId, r.contentHash]));

  const pending = [...current].filter(
    ([id, { hash }]) => !live.has(id) || recordedHash.get(id) !== hash,
  );

  if (pending.length > 0) await store.ensureTable(ns);
  for (let i = 0; i < pending.length; i += MAX_EMBED_TEXTS_PER_REQUEST) {
    const batch = pending.slice(i, i + MAX_EMBED_TEXTS_PER_REQUEST);
    const { vectors, model: usedModel } = await embedService.embed(batch.map(([, r]) => r.text));
    if (vectors.length !== batch.length) {
      throw new Error(
        `requirement embedder returned ${vectors.length} vectors for ${batch.length} requirements`,
      );
    }
    const rows: VectorRow[] = batch.map(([id, r], j) => ({
      id,
      vector: vectors[j],
      metadata: {
        chunkId: id,
        documentId: id,
        filename: "",
        position: 0,
        text: r.text,
        embeddingModel: usedModel,
      },
    }));
    await store.upsert(ns, rows);
    // Bookkeeping AFTER the vectors, so a row never claims a vector that was not written.
    for (const [id, r] of batch) {
      const contentHash = requirementContentHash(usedModel, r.text);
      await db.requirementEmbedding.upsert({
        where: { requirementId: id },
        create: { requirementId: id, projectId, contentHash, embeddingModel: usedModel },
        update: { projectId, contentHash, embeddingModel: usedModel, embeddedAt: new Date() },
      });
    }
  }

  // Vectors of requirements that are gone (a re-run's delete-and-recreate, a hard
  // delete) or soft-deleted. A hard delete already cascaded the bookkeeping row; a
  // soft-deleted requirement's row is removed here so it is re-embedded if restored.
  const orphans = refs.map((r) => r.chunkId).filter((id) => !current.has(id));
  const deleted = orphans.length > 0 ? await store.deleteByChunkIds(ns, orphans) : 0;
  const staleRecords = recorded.map((r) => r.requirementId).filter((id) => !current.has(id));
  if (staleRecords.length > 0) {
    await db.requirementEmbedding.deleteMany({
      where: { projectId, requirementId: { in: staleRecords } },
    });
  }

  const result: RequirementSyncResult = {
    projectId,
    embedded: pending.length,
    unchanged: current.size - pending.length,
    deleted,
  };
  if (result.embedded > 0 || result.deleted > 0) {
    log.info("requirement vectors reconciled", { ...result });
  }
  return result;
}

export interface NearestRequirement {
  requirementId: string;
  /** Cosine similarity of the query and the requirement's vector. */
  score: number;
}

export interface FindNearestOptions extends RequirementEmbeddingDeps {
  /** How many neighbours to return. Default 5. */
  limit?: number;
  /** Requirement ids never to return (the requirement being compared, say). */
  excludeIds?: readonly string[];
}

/**
 * The project's live requirements nearest to `text`, best first.
 *
 * Reconciles first, so the answer reflects every committed edit. Only
 * `<projectId>__requirements` is searched, and each hit is re-read on the project
 * AND the id AND `deletedAt: null` before it is returned.
 */
export async function findNearestRequirements(
  projectId: string,
  text: string,
  opts: FindNearestOptions = {},
): Promise<NearestRequirement[]> {
  const limit = Math.max(0, Math.floor(opts.limit ?? 5));
  if (limit === 0 || text.trim().length === 0) return [];
  const deps = resolveDeps(opts);
  await syncRequirementEmbeddings(projectId, deps);

  const exclude = new Set(opts.excludeIds ?? []);
  const { vectors } = await deps.embedService.embed([text]);
  const query = vectors[0];
  if (!query || query.length === 0) return [];
  const hits = await deps.store.search(
    requirementVectorsId(projectId),
    query,
    limit + exclude.size,
    { embeddingModel: deps.model() },
  );
  const candidates = hits.filter((h) => !exclude.has(h.row.id));
  if (candidates.length === 0) return [];

  const alive = await deps.db.requirement.findMany({
    where: { projectId, id: { in: candidates.map((h) => h.row.id) }, deletedAt: null },
    select: { id: true },
  });
  const aliveIds = new Set(alive.map((r) => r.id));
  return candidates
    .filter((h) => aliveIds.has(h.row.id))
    .slice(0, limit)
    .map((h) => ({ requirementId: h.row.id, score: h.score }));
}

// ---- Enqueue from writers --------------------------------------------------

/** Debounce for a writer's enqueue: a re-run writes many rows in a burst. */
export const REQUIREMENT_SYNC_DEBOUNCE_MS = 2_000;

const timers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Whether writers warm the index (`REQUIREMENT_EMBEDDINGS_SYNC_ON_WRITE`, default
 * on). Off only skips the warm-up: every query still reconciles first.
 */
export function requirementSyncOnWriteEnabled(): boolean {
  const raw = (process.env.REQUIREMENT_EMBEDDINGS_SYNC_ON_WRITE ?? "").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off";
}

/**
 * Schedule a reconcile of `projectId` after the writer's burst settles. Never
 * throws and never blocks the writer: a failure is logged, and the next query
 * reconciles anyway.
 */
export function enqueueRequirementEmbeddingSync(projectId: string): void {
  if (!requirementSyncOnWriteEnabled()) return;
  const existing = timers.get(projectId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    timers.delete(projectId);
    syncRequirementEmbeddings(projectId).catch((err: unknown) => {
      log.warn("requirement embedding reconcile failed; the next query retries it", {
        projectId,
        error: (err as Error).message,
      });
    });
  }, REQUIREMENT_SYNC_DEBOUNCE_MS);
  timer.unref?.();
  timers.set(projectId, timer);
}

/**
 * {@link enqueueRequirementEmbeddingSync} for writers that know the requirement
 * ids but not their project (an edit, a restore). The lookup runs in the
 * background too.
 */
export function enqueueRequirementEmbeddingSyncFor(requirementIds: readonly string[]): void {
  if (!requirementSyncOnWriteEnabled() || requirementIds.length === 0) return;
  prisma.requirement
    .findMany({ where: { id: { in: [...new Set(requirementIds)] } }, select: { projectId: true } })
    .then((rows) => {
      for (const projectId of new Set(rows.map((r) => r.projectId))) {
        enqueueRequirementEmbeddingSync(projectId);
      }
    })
    .catch((err: unknown) => {
      log.warn("could not resolve the project of an edited requirement", {
        error: (err as Error).message,
      });
    });
}

/** Test seam: cancel every scheduled reconcile. */
export function __cancelRequirementSyncTimers(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
}
