/**
 * Epic #1866 (#1869) — the governing-document retrieval index: one vector table
 * per workspace, in the governing namespace of the vector store
 * (`getGoverningVectorSpace`, `<root>/governing/<workspaceId>` on the file
 * stores), never a project's table and never a global one.
 *
 * Each chunk's vector row carries its REVISION id as `documentId`: that is the
 * one per-chunk field every backend persists (Lance and pgvector keep a fixed
 * column set), so a search filters to revisions by it. A new revision adds rows
 * and leaves the previous revision's rows in place; a search returns the current
 * revision's chunks unless it asks for superseded ones too.
 *
 * `search` checks the actor's workspace membership BEFORE it touches the table,
 * and re-reads the searchable revisions from the database, so a stale vector of
 * a deleted document, or a revision of another workspace, cannot surface.
 * Behind `GOVERNING_DOCS_ENABLED`: with the flag off a search returns nothing.
 */
import { DEFAULT_RAG_CHUNK_OVERLAP, DEFAULT_RAG_CHUNK_SIZE } from "@metis/shared";
import { chunkMarkdown, type ChunkOptions } from "../rag/chunker.js";
import { embedInBoundedBatches } from "../rag/embed-batched.js";
import type { EmbeddingResult } from "../rag/embedder-registry.js";
import { getEmbedder } from "../rag/embedder.js";
import {
  getGoverningVectorSpace,
  type GoverningVectorSpace,
  type VectorRow,
} from "../rag/vector-store.js";
import { isGoverningDocsEnabled } from "./flag.js";
import { canReadWorkspace, searchableRevisions, type GoverningActor } from "./governing-store.js";

/** The embedder surface the index needs. */
export interface GoverningEmbedder {
  embed(texts: string[]): Promise<EmbeddingResult>;
}

export interface GoverningIndexDeps {
  space?: GoverningVectorSpace;
  embedder?: GoverningEmbedder;
  chunkOptions?: ChunkOptions;
}

export interface GoverningSearchHit {
  documentId: string;
  revisionId: string;
  revisionLabel: string;
  title: string;
  position: number;
  text: string;
  score: number;
}

export interface GoverningSearchOptions {
  /** Also return chunks of revisions that are no longer current. Default false. */
  includeSuperseded?: boolean;
}

/** Search results per call: at least one, at most this many. */
export const MAX_GOVERNING_SEARCH_K = 50;

export class GoverningIndex {
  private readonly space: GoverningVectorSpace;
  private readonly embedder: GoverningEmbedder;
  private readonly chunkOptions: ChunkOptions;

  constructor(deps: GoverningIndexDeps = {}) {
    this.space = deps.space ?? getGoverningVectorSpace();
    this.embedder = deps.embedder ?? getEmbedder();
    this.chunkOptions = deps.chunkOptions ?? {
      chunkSize: DEFAULT_RAG_CHUNK_SIZE,
      overlap: DEFAULT_RAG_CHUNK_OVERLAP,
    };
  }

  /**
   * Chunk, embed and store one revision's text in its workspace's table.
   * Returns the number of chunks written. The caller has already authorised the
   * write and stored the revision row.
   */
  async indexRevision(input: {
    workspaceId: string;
    revisionId: string;
    filename: string;
    text: string;
  }): Promise<number> {
    const chunks = chunkMarkdown(input.text, this.chunkOptions);
    if (chunks.length === 0) return 0;
    const embeddings = await embedInBoundedBatches(
      this.embedder,
      chunks.map((c) => c.text),
    );
    if (embeddings.vectors.length !== chunks.length) {
      throw new Error(
        `embedder returned ${embeddings.vectors.length} vectors for ${chunks.length} chunks`,
      );
    }
    const embeddingModel = embeddings.identity ?? embeddings.model;
    const rows: VectorRow[] = chunks.map((chunk, i) => {
      const chunkId = `${input.revisionId}:${chunk.position}`;
      return {
        id: chunkId,
        vector: embeddings.vectors[i],
        metadata: {
          documentId: input.revisionId,
          chunkId,
          filename: input.filename,
          position: chunk.position,
          text: chunk.text,
          embeddingModel,
        },
      };
    });
    const key = this.space.tableKey(input.workspaceId);
    await this.space.store.ensureTable(key);
    await this.space.store.upsert(key, rows);
    return rows.length;
  }

  /**
   * Top-`k` chunks of the workspace's governing documents for `query`. Returns
   * nothing — without reading the table — when the flag is off or `actor` may not
   * read the workspace.
   */
  async search(
    workspaceId: string,
    query: string,
    k: number,
    actor: GoverningActor,
    opts: GoverningSearchOptions = {},
  ): Promise<GoverningSearchHit[]> {
    if (!isGoverningDocsEnabled()) return [];
    if (!query || query.trim().length === 0) return [];
    if (!(await canReadWorkspace(workspaceId, actor))) return [];
    const revisions = await searchableRevisions(workspaceId, opts);
    if (revisions.size === 0) return [];

    const limit = Math.min(Math.max(Math.floor(k) || 1, 1), MAX_GOVERNING_SEARCH_K);
    const queryEmbed = await this.embedder.embed([query]);
    const hits = await this.space.store.search(
      this.space.tableKey(workspaceId),
      queryEmbed.vectors[0],
      limit,
      {
        embeddingModel: queryEmbed.identity ?? queryEmbed.model,
        documentIds: [...revisions.keys()],
      },
    );
    const out: GoverningSearchHit[] = [];
    for (const hit of hits) {
      const revision = revisions.get(hit.row.metadata.documentId);
      if (!revision) continue;
      out.push({
        documentId: revision.documentId,
        revisionId: hit.row.metadata.documentId,
        revisionLabel: revision.revisionLabel,
        title: revision.title,
        position: hit.row.metadata.position,
        text: hit.row.metadata.text,
        score: hit.score,
      });
    }
    return out;
  }
}

let singleton: GoverningIndex | null = null;

export function getGoverningIndex(): GoverningIndex {
  singleton ??= new GoverningIndex();
  return singleton;
}

/** Test seam. */
export function __resetGoverningIndexSingleton(): void {
  singleton = null;
}
