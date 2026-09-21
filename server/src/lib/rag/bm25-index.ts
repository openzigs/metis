/**
 * BM25 sparse index — Phase 5 follow-up (issue #131).
 *
 * Wraps `minisearch` to provide an in-memory BM25-style sparse index per
 * project, keyed by the same `chunkId` that the dense vector store uses.
 * The dense + sparse top-k are merged via reciprocal rank fusion in
 * {@link reciprocalRankFusion}.
 *
 * The index is built lazily from the persisted `KnowledgeChunk` rows the
 * first time a project is searched, then mutated incrementally on
 * subsequent ingest / delete calls so we never rebuild unless the singleton
 * is reset (tests + project archive).
 */
import MiniSearch from "minisearch";
import { prisma } from "../prisma.js";

export interface BM25Doc {
  id: string;
  documentId: string;
  text: string;
  position: number;
  filename: string;
}

export interface BM25Hit {
  chunkId: string;
  score: number;
}

const INDEX_OPTS = {
  fields: ["text"],
  storeFields: ["documentId", "filename", "position"],
};

const SEARCH_OPTS = {
  boost: { text: 1 },
  fuzzy: 0,
  prefix: true,
  combineWith: "OR" as const,
};

interface ProjectState {
  index: MiniSearch<BM25Doc>;
  /** documentId → Set of chunkIds currently in the index. */
  byDoc: Map<string, Set<string>>;
  loaded: boolean;
}

export class BM25Index {
  private projects = new Map<string, ProjectState>();
  private loading = new Map<string, Promise<ProjectState>>();

  /**
   * Ensure an index exists for the project. If we have not seen the project
   * before, lazy-load every persisted chunk into a fresh MiniSearch
   * instance. Subsequent calls are O(1).
   */
  async ensureProject(projectId: string): Promise<ProjectState> {
    const pending = this.loading.get(projectId);
    if (pending) return pending;
    const load = this.loadProject(projectId);
    this.loading.set(projectId, load);
    try {
      return await load;
    } catch (error) {
      // Never retry into a partially populated MiniSearch instance.
      this.projects.delete(projectId);
      throw error;
    } finally {
      this.loading.delete(projectId);
    }
  }

  private async loadProject(projectId: string): Promise<ProjectState> {
    let state = this.projects.get(projectId);
    if (!state) {
      state = {
        index: new MiniSearch<BM25Doc>(INDEX_OPTS),
        byDoc: new Map(),
        loaded: false,
      };
      this.projects.set(projectId, state);
    }
    if (!state.loaded) {
      const rows = await prisma.knowledgeChunk.findMany({
        where: { projectId },
        select: { id: true, documentId: true, position: true, text: true },
      });
      const docs = await prisma.document.findMany({
        where: { projectId, deletedAt: null },
        select: { id: true, filename: true },
      });
      const filenames = new Map(docs.map((d) => [d.id, d.filename]));
      const bulk: BM25Doc[] = rows.map((r) => ({
        id: r.id,
        documentId: r.documentId,
        position: r.position,
        text: r.text,
        filename: filenames.get(r.documentId) ?? "",
      }));
      if (bulk.length > 0) state.index.addAll(bulk);
      for (const c of bulk) {
        let set = state.byDoc.get(c.documentId);
        if (!set) {
          set = new Set();
          state.byDoc.set(c.documentId, set);
        }
        set.add(c.id);
      }
      state.loaded = true;
    }
    return state;
  }

  /**
   * Replace any chunks tied to `documentId` with the supplied set. Safe to
   * call before the project has been lazy-loaded — the lazy load runs first
   * and the mutation applies on top.
   */
  async upsertDocumentChunks(
    projectId: string,
    documentId: string,
    filename: string,
    chunks: { id: string; position: number; text: string }[],
    replace = true,
  ): Promise<void> {
    const state = await this.ensureProject(projectId);
    if (replace) this.removeDocumentInState(state, documentId);
    if (chunks.length === 0) return;
    // Track IDs before addAll: if it throws after adding a prefix, retry can
    // remove exactly that prefix rather than orphaning it in a warm index.
    const ids = state.byDoc.get(documentId) ?? new Set<string>();
    for (const chunk of chunks) {
      ids.add(chunk.id);
      if (state.index.has(chunk.id)) state.index.discard(chunk.id);
    }
    state.byDoc.set(documentId, ids);
    state.index.addAll(
      chunks.map((c) => ({
        id: c.id,
        documentId,
        position: c.position,
        text: c.text,
        filename,
      })),
    );
  }

  async removeDocument(projectId: string, documentId: string): Promise<void> {
    // A cold load may already have read the soon-to-be-deleted SQL rows.
    // Wait for its snapshot before deleting, rather than letting it resurrect them.
    await this.loading.get(projectId);
    const state = this.projects.get(projectId);
    if (!state) return;
    this.removeDocumentInState(state, documentId);
  }

  /** Attempt compensation must never remove another attempt's sparse rows. */
  async removeChunkIds(projectId: string, documentId: string, chunkIds: string[]): Promise<void> {
    await this.loading.get(projectId);
    const state = this.projects.get(projectId);
    if (!state) return;
    const ids = state.byDoc.get(documentId);
    for (const id of chunkIds) {
      if (state.index.has(id)) state.index.discard(id);
      ids?.delete(id);
    }
    if (ids?.size === 0) state.byDoc.delete(documentId);
  }

  /** Snapshot candidates before a durable SQL disposition fence, not after it. */
  async documentChunkIds(projectId: string, documentId: string): Promise<string[]> {
    await this.loading.get(projectId);
    return [...(this.projects.get(projectId)?.byDoc.get(documentId) ?? [])];
  }

  /** Only safe when the caller excludes concurrent writers for this document. */
  async removeUnselectedChunks(
    projectId: string,
    documentId: string,
    selected: Set<string>,
  ): Promise<void> {
    await this.loading.get(projectId);
    const ids = this.projects.get(projectId)?.byDoc.get(documentId);
    await this.removeChunkIds(
      projectId,
      documentId,
      [...(ids ?? [])].filter((id) => !selected.has(id)),
    );
  }

  dropProject(projectId: string): void {
    this.projects.delete(projectId);
  }

  async search(projectId: string, query: string, k: number): Promise<BM25Hit[]> {
    const trimmed = query.trim();
    if (trimmed.length === 0) return [];
    const state = await this.ensureProject(projectId);
    const raw = state.index.search(trimmed, SEARCH_OPTS);
    return raw.slice(0, k).map((r) => ({ chunkId: String(r.id), score: r.score }));
  }

  private removeDocumentInState(state: ProjectState, documentId: string): void {
    const ids = state.byDoc.get(documentId);
    if (!ids) return;
    for (const id of ids) {
      // A partial failure retains the remaining IDs for retry. Already removed
      // IDs are harmless; real index failures must reach the publication task.
      if (state.index.has(id)) state.index.discard(id);
      ids.delete(id);
    }
    state.byDoc.delete(documentId);
  }
}

/**
 * Reciprocal Rank Fusion (Cormack/Clarke/Buettcher 2009).
 *
 *   score(d) = Σ 1 / (k + rank_i(d))
 *
 * `lists` is one ranked list per retrieval source. Documents that appear in
 * multiple lists rank higher than documents that only appear in one. The
 * canonical default is k = 60.
 */
export function reciprocalRankFusion(
  lists: { chunkId: string; score?: number }[][],
  opts: { k?: number; topK?: number } = {},
): { chunkId: string; score: number }[] {
  const k = opts.k ?? 60;
  const acc = new Map<string, number>();
  for (const list of lists) {
    list.forEach((hit, idx) => {
      const rank = idx + 1;
      const contrib = 1 / (k + rank);
      acc.set(hit.chunkId, (acc.get(hit.chunkId) ?? 0) + contrib);
    });
  }
  const sorted = [...acc.entries()].map(([chunkId, score]) => ({ chunkId, score }));
  sorted.sort((a, b) => b.score - a.score);
  if (opts.topK != null) return sorted.slice(0, opts.topK);
  return sorted;
}

let singleton: BM25Index | null = null;
export function getBM25Index(): BM25Index {
  if (!singleton) singleton = new BM25Index();
  return singleton;
}

/** Test seam — drop the singleton so each test file starts cold. */
export function __resetBM25IndexSingleton(): void {
  singleton = null;
}
