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
 *     ProjectContentVersion.complete} and callers must not cache under it.
 *   - **Symbol embeddings**: the project's `CodeSymbolEmbedding` count per
 *     model. They are filled in by a background job AFTER the ingest finishes
 *     (#797), and `search_code_symbols` ranks on them, so the key moves while
 *     they fill in.
 *   - **Documents**: a hash over every document row's indexing state (checksum,
 *     status, index state, chunk count, ACL subjects, processed and deleted
 *     times, names). `Document` has no `updatedAt` column, and a hash over the
 *     rows catches an upload (new row), a re-upload or re-index (checksum,
 *     `processedAt`), an ACL edit, a soft delete (`deletedAt`) and a hard delete
 *     (row gone) alike.
 *   - **The active embedder model**: both searches filter on it, so a model
 *     flip moves the key.
 *
 * Reads only; every query is scoped by `projectId`.
 */
import crypto from "node:crypto";
import { prisma } from "../prisma.js";
import { getEmbedder } from "../rag/embedder.js";

export interface ProjectContentVersion {
  /** Commit SHA per code graph, keyed by repo connection id (`graph:<id>` for a graph with none). */
  codeShas: Record<string, string | null>;
  /** Hash of the project's document set. */
  docsVersion: string;
  /** sha256 of everything above (and the embedding state): the version as one string. */
  key: string;
  /** False when a code graph has no commit SHA: never cache under this version. */
  complete: boolean;
}

/** What the version is read from; tests pass their own. */
export interface ContentVersionSource {
  codeGraphs(projectId: string): Promise<
    Array<{
      id: string;
      repoConnectionId: string | null;
      commitSha: string | null;
      lastIndexedAt: Date | null;
    }>
  >;
  symbolEmbeddingCounts(projectId: string): Promise<Array<{ model: string; count: number }>>;
  documents(projectId: string): Promise<
    Array<{
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
    }>
  >;
  embedderModel(): string;
}

export const prismaContentVersionSource: ContentVersionSource = {
  codeGraphs: (projectId) =>
    prisma.codeGraph.findMany({
      where: { projectId },
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
  documents: (projectId) =>
    prisma.document.findMany({
      where: { projectId },
      select: {
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
      },
    }),
  embedderModel: () => getEmbedder().model,
};

const sha256 = (s: string): string => crypto.createHash("sha256").update(s).digest("hex");
const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const byKey = <T>(rows: T[], key: (r: T) => string): T[] =>
  [...rows].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));

/** The project's content version, read now. */
export async function getProjectContentVersion(
  projectId: string,
  source: ContentVersionSource = prismaContentVersionSource,
): Promise<ProjectContentVersion> {
  const [graphs, symbolCounts, documents] = await Promise.all([
    source.codeGraphs(projectId),
    source.symbolEmbeddingCounts(projectId),
    source.documents(projectId),
  ]);

  const codeShas: Record<string, string | null> = {};
  const code: Array<[string, string | null, string | null]> = [];
  for (const g of byKey(graphs, (g) => g.id)) {
    const repo = g.repoConnectionId ?? `graph:${g.id}`;
    codeShas[repo] = g.commitSha;
    code.push([repo, g.commitSha, iso(g.lastIndexedAt)]);
  }
  code.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const docsVersion = sha256(
    JSON.stringify(
      byKey(documents, (d) => d.id).map((d) => [
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
      ]),
    ),
  );

  const key = sha256(
    JSON.stringify({
      projectId,
      code,
      symbols: byKey(symbolCounts, (s) => s.model).map((s) => [s.model, s.count]),
      docsVersion,
      embedder: source.embedderModel(),
    }),
  );

  return {
    codeShas,
    docsVersion,
    key,
    complete: graphs.every((g) => g.commitSha !== null),
  };
}
