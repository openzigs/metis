/**
 * #1843 — a project's CONTENT VERSION: one key that changes whenever what the
 * chat tools read from the project could have changed.
 *
 * Chat's read tools (`search_code_graph`, `search_code_symbols`,
 * `read_file_slice`, `search-knowledge`) answer deterministically for a given
 * tool, arguments, project, caller and content. This key stands for that
 * content, so a cache keyed on it serves an entry only while the code and the
 * documents it was computed from are still the ones the project has. A
 * re-ingest moves the key, which makes every older entry unreachable; nothing
 * has to be invalidated by hand.
 *
 * What goes into the key:
 *
 *   - **Code**, per code graph: its `commitSha` and `lastIndexedAt`. Both are
 *     written only when an ingest FINISHES (`code-graph/ingest.ts`, #758), so an
 *     ingest still running, or one that failed part-way, does not move the key.
 *     `lastIndexedAt` also moves on a finished re-ingest of the same commit (an
 *     extractor upgrade rewrites rows in place). A graph with no `commitSha` has
 *     no finished, labelled ingest: the version is then not {@link
 *     ProjectContentVersion.complete} and the code tools must not cache under it.
 *     #1864 — a graph whose repo connection is soft-deleted is left out, so
 *     removing a repo moves the key and nothing cached from it is served again.
 *   - **Symbol embeddings**: the project's `CodeSymbolEmbedding` count per
 *     model. They are filled in by a background job AFTER the ingest finishes
 *     (#797), and `search_code_symbols` ranks on them, so the key moves while
 *     they fill in.
 *   - **Document chunks' embedding models** (#1864): the project's
 *     `KnowledgeChunk` count per `embeddingModel`. `reindexProject` and
 *     `retagToActiveModel` re-embed and retag chunks without touching any
 *     document row, and `search-knowledge` ranks only the chunks tagged with
 *     the active identity, so a reindex moves the key.
 *   - **Documents** (#1864): the project's row count, the latest `updatedAt`
 *     (Prisma sets it on every create and update), and a hash over the indexing
 *     state of the rows written within {@link RECENT_WRITE_WINDOW_MS} of that
 *     latest write. The count catches a hard delete; the latest write catches an
 *     upload, a re-upload, a re-index, an ACL edit and a soft delete; the recent
 *     rows catch a second write in the same millisecond, which leaves the
 *     latest write where it was. Two aggregates over the (`projectId`,
 *     `updatedAt`) index, where #1843 read and hashed every document row
 *     (repository source files are document rows too) on each call.
 *   - **The active embedder identity**: both searches filter on it (#792:
 *     `model`, or `model|pooling|dtype`), so a model or pooling flip moves the
 *     key.
 *
 * Reads only; every query is scoped by `projectId`.
 */
import crypto from "node:crypto";
import { prisma } from "../prisma.js";
import { getEmbedder } from "../rag/embedder.js";

/**
 * #1864 — how far before the project's latest document write the rows are
 * hashed individually. Covers a second write in the same millisecond, and app
 * servers whose clocks disagree by less than this.
 */
export const RECENT_WRITE_WINDOW_MS = 60_000;

export interface ProjectContentVersion {
  /** Commit SHA per code graph, keyed by repo connection id (`graph:<id>` for a graph with none). */
  codeShas: Record<string, string | null>;
  /** Hash of the project's document set. */
  docsVersion: string;
  /** sha256 of everything above (and the embedding state): the version as one string. */
  key: string;
  /**
   * False when a code graph has no commit SHA: the code tools must not cache
   * under this version. `search-knowledge` reads no code graph and may (#1864).
   */
  complete: boolean;
}

/** One document row's indexing state, as the version hashes it. */
export interface ContentVersionDocument {
  id: string;
  filename: string;
  title: string | null;
  checksum: string;
  status: string;
  indexState: string;
  chunkCount: number;
  aclSubjects: string;
  processedAt: Date | null;
  deletedAt: Date | null;
  updatedAt: Date | null;
}

/** What the version is read from; tests pass their own. */
export interface ContentVersionSource {
  /** The project's code graphs, leaving out those of soft-deleted repo connections. */
  codeGraphs(projectId: string): Promise<
    Array<{
      id: string;
      repoConnectionId: string | null;
      commitSha: string | null;
      lastIndexedAt: Date | null;
    }>
  >;
  symbolEmbeddingCounts(projectId: string): Promise<Array<{ model: string; count: number }>>;
  chunkEmbeddingCounts(projectId: string): Promise<Array<{ model: string; count: number }>>;
  /** The project's document row count and latest `updatedAt`. */
  documentSummary(projectId: string): Promise<{ count: number; latestWrite: Date | null }>;
  /** The project's document rows whose `updatedAt` is at or after `since`. */
  documentsWrittenSince(projectId: string, since: Date): Promise<ContentVersionDocument[]>;
  embedderIdentity(): Promise<string> | string;
}

const DOCUMENT_SELECT = {
  id: true,
  filename: true,
  title: true,
  checksum: true,
  status: true,
  indexState: true,
  chunkCount: true,
  aclSubjects: true,
  processedAt: true,
  deletedAt: true,
  updatedAt: true,
} as const;

export const prismaContentVersionSource: ContentVersionSource = {
  codeGraphs: (projectId) =>
    prisma.codeGraph.findMany({
      where: {
        projectId,
        OR: [{ repoConnectionId: null }, { repoConnection: { is: { deletedAt: null } } }],
      },
      select: { id: true, repoConnectionId: true, commitSha: true, lastIndexedAt: true },
    }),
  async symbolEmbeddingCounts(projectId) {
    const grouped = await prisma.codeSymbolEmbedding.groupBy({
      by: ["embeddingModel"],
      where: { projectId },
      _count: { _all: true },
    });
    return grouped.map((g) => ({ model: g.embeddingModel, count: g._count._all }));
  },
  async chunkEmbeddingCounts(projectId) {
    const grouped = await prisma.knowledgeChunk.groupBy({
      by: ["embeddingModel"],
      where: { projectId },
      _count: { _all: true },
    });
    return grouped.map((g) => ({ model: g.embeddingModel, count: g._count._all }));
  },
  async documentSummary(projectId) {
    const agg = await prisma.document.aggregate({
      where: { projectId },
      _count: { _all: true },
      _max: { updatedAt: true },
    });
    return { count: agg._count._all, latestWrite: agg._max.updatedAt };
  },
  documentsWrittenSince: (projectId, since) =>
    prisma.document.findMany({
      where: { projectId, updatedAt: { gte: since } },
      select: DOCUMENT_SELECT,
    }),
  embedderIdentity: () => getEmbedder().currentIdentity(),
};

const sha256 = (s: string): string => crypto.createHash("sha256").update(s).digest("hex");
const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const byKey = <T>(rows: T[], key: (r: T) => string): T[] =>
  [...rows].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
const modelCounts = (rows: Array<{ model: string; count: number }>) =>
  byKey(rows, (s) => s.model).map((s) => [s.model, s.count]);

async function documentsVersion(projectId: string, source: ContentVersionSource): Promise<string> {
  const { count, latestWrite } = await source.documentSummary(projectId);
  const recent = latestWrite
    ? await source.documentsWrittenSince(
        projectId,
        new Date(latestWrite.getTime() - RECENT_WRITE_WINDOW_MS),
      )
    : [];
  return sha256(
    JSON.stringify([
      count,
      iso(latestWrite),
      byKey(recent, (d) => d.id).map((d) => [
        d.id,
        d.filename,
        d.title,
        d.checksum,
        d.status,
        d.indexState,
        d.chunkCount,
        d.aclSubjects,
        iso(d.processedAt),
        iso(d.deletedAt),
        iso(d.updatedAt),
      ]),
    ]),
  );
}

/** The project's content version, read now. */
export async function getProjectContentVersion(
  projectId: string,
  source: ContentVersionSource = prismaContentVersionSource,
): Promise<ProjectContentVersion> {
  const [graphs, symbolCounts, chunkCounts, docsVersion, embedder] = await Promise.all([
    source.codeGraphs(projectId),
    source.symbolEmbeddingCounts(projectId),
    source.chunkEmbeddingCounts(projectId),
    documentsVersion(projectId, source),
    source.embedderIdentity(),
  ]);

  const codeShas: Record<string, string | null> = {};
  const code: Array<[string, string | null, string | null]> = [];
  for (const g of byKey(graphs, (g) => g.id)) {
    const repo = g.repoConnectionId ?? `graph:${g.id}`;
    codeShas[repo] = g.commitSha;
    code.push([repo, g.commitSha, iso(g.lastIndexedAt)]);
  }
  code.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const key = sha256(
    JSON.stringify({
      projectId,
      code,
      symbols: modelCounts(symbolCounts),
      chunks: modelCounts(chunkCounts),
      docsVersion,
      embedder,
    }),
  );

  return {
    codeShas,
    docsVersion,
    key,
    complete: graphs.every((g) => g.commitSha !== null),
  };
}
