/**
 * #2346 — is a project's symbol index consistent, and repair it when not.
 *
 * A symbol is indexed in two stores (`symbol-embedding-service.ts`): its
 * vector in the vector store (`<projectId>__symbols`, LanceDB by default) and
 * its durable metadata in `CodeSymbolEmbedding` (text, hash, model tag). The
 * two are written in separate steps, and a crash, a failed embed job or an
 * operator's hand on one store can leave them disagreeing. This module finds,
 * per project:
 *
 *   - **orphan vectors**: a stored vector whose symbol has no metadata row (its
 *     symbol was deleted and nothing pruned the vector);
 *   - **missing vectors**: a metadata row tagged as embedded at a model, with no
 *     vector of that model under its id. Semantic search cannot find the
 *     symbol, and the embed job never retries it, because the tag says done;
 *   - **pending embeddings**: rows never embedded (`embeddingModel` empty). Normal
 *     while the background job runs; reported, not an inconsistency;
 *   - **commit drift**: a code graph whose commit is not its repository's last
 *     indexed commit (`RepoConnection.lastCommitSha`, written with the graph's
 *     by #758), so its symbols describe another version of the code.
 *
 * {@link checkIndexConsistency} only reads. {@link repairIndexConsistency}
 * re-queues the missing embeddings (their tags go back to PENDING and the embed
 * job runs) and removes the orphans, holding every repository connection's
 * ingest lease (`ingest-guard.ts`) so no ingest of the project rewrites its
 * symbols meanwhile, and the project's reindex fence, which every writer of the
 * symbol vectors takes. Commit drift is reported only: a re-sync of the
 * repository fixes it. Run again, the repair finds nothing to do.
 */
import { prisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";
import { getVectorStore, type VectorStore } from "../rag/vector-store.js";
import { ReindexFencedError } from "../rag/reindex-lease.js";
import {
  tryAcquireConnectorIngest,
  type ConnectorIngestLease,
} from "../connectors/ingest-guard.js";
import {
  PENDING_MODEL,
  createSymbolEmbeddingStore,
  embedProjectSymbols,
  symbolVectorsId,
  withSymbolFence,
  type SymbolEmbeddingDeps,
} from "./symbol-embedding-service.js";
import type { PipelineResult } from "./symbol-embeddings.js";

const log = createChildLogger("index-consistency");

/** Ids per `IN (...)` when re-queueing. */
const UPDATE_CHUNK = 1000;
/** The ingest-lease holder name a repair takes. */
export const REPAIR_HOLDER = "index-consistency-repair";

/** One code graph whose commit is not its repository's last indexed commit. */
export interface CommitDrift {
  repoConnectionId: string;
  graphCommit: string | null;
  indexedCommit: string | null;
  symbols: number;
}

/** What {@link checkIndexConsistency} found. Ids are kept for the repair, never shown. */
export interface IndexConsistencyCheck {
  projectId: string;
  orphanVectorIds: string[];
  missingVectorIds: string[];
  pendingEmbeddings: number;
  commitDrift: CommitDrift[];
}

/** The counts of a check: what a report, the CLI and the index status show. */
export interface IndexConsistencySummary {
  orphanVectors: number;
  missingVectors: number;
  pendingEmbeddings: number;
  /** Symbols in graphs at another commit than their repository's last indexed one. */
  driftedSymbols: number;
  /** The graphs those symbols are in. */
  driftedGraphs: number;
}

export interface IndexConsistencyDeps extends SymbolEmbeddingDeps {
  /** Run the embed job; defaults to {@link embedProjectSymbols}. */
  embed?: typeof embedProjectSymbols;
}

/** A check's counts. */
export function summarizeConsistency(check: IndexConsistencyCheck): IndexConsistencySummary {
  return {
    orphanVectors: check.orphanVectorIds.length,
    missingVectors: check.missingVectorIds.length,
    pendingEmbeddings: check.pendingEmbeddings,
    driftedSymbols: check.commitDrift.reduce((n, d) => n + d.symbols, 0),
    driftedGraphs: check.commitDrift.length,
  };
}

/** True when nothing disagrees. Pending embeddings are not a disagreement. */
export function isConsistent(s: IndexConsistencySummary): boolean {
  return s.orphanVectors === 0 && s.missingVectors === 0 && s.driftedGraphs === 0;
}

/** Read-only: the project's symbol vectors against its metadata rows and its graphs' commits. */
export async function checkIndexConsistency(
  projectId: string,
  deps: Pick<IndexConsistencyDeps, "store"> = {},
): Promise<IndexConsistencyCheck> {
  const store: VectorStore = deps.store ?? getVectorStore();
  const [refs, rows, graphs, symbolCounts] = await Promise.all([
    store.listChunkRefs(symbolVectorsId(projectId)),
    prisma.codeSymbolEmbedding.findMany({
      where: { projectId },
      select: { symbolId: true, embeddingModel: true },
    }),
    prisma.codeGraph.findMany({
      where: { projectId, repoConnectionId: { not: null } },
      select: {
        id: true,
        repoConnectionId: true,
        commitSha: true,
        repoConnection: { select: { lastCommitSha: true, projectId: true } },
      },
    }),
    prisma.codeSymbol.groupBy({
      by: ["codeGraphId"],
      where: { projectId },
      _count: { _all: true },
    }),
  ]);

  const vectorModel = new Map(refs.map((r) => [r.chunkId, r.embeddingModel] as const));
  const rowIds = new Set(rows.map((r) => r.symbolId));
  const orphanVectorIds = refs.map((r) => r.chunkId).filter((id) => !rowIds.has(id));
  const missingVectorIds = rows
    .filter(
      (r) => r.embeddingModel !== PENDING_MODEL && vectorModel.get(r.symbolId) !== r.embeddingModel,
    )
    .map((r) => r.symbolId);
  const pendingEmbeddings = rows.filter((r) => r.embeddingModel === PENDING_MODEL).length;

  const countByGraph = new Map(symbolCounts.map((g) => [g.codeGraphId, g._count._all] as const));
  const commitDrift: CommitDrift[] = graphs
    // A connection in another project is not this graph's repository.
    .filter((g) => g.repoConnection && g.repoConnection.projectId === projectId)
    .filter((g) => g.commitSha !== g.repoConnection!.lastCommitSha)
    .map((g) => ({
      repoConnectionId: g.repoConnectionId!,
      graphCommit: g.commitSha,
      indexedCommit: g.repoConnection!.lastCommitSha,
      symbols: countByGraph.get(g.id) ?? 0,
    }));

  return { projectId, orphanVectorIds, missingVectorIds, pendingEmbeddings, commitDrift };
}

/** The repair's outcome. */
export type IndexRepairResult =
  | {
      status: "repaired";
      before: IndexConsistencySummary;
      after: IndexConsistencySummary;
      /** Rows tagged as embedded with no vector, put back to PENDING. */
      requeued: number;
      /** Orphan vectors removed (by the embed job, or after it). */
      removedOrphans: number;
      embed: PipelineResult | null;
    }
  | {
      /** A repository connection of the project is being ingested: nothing was changed. */
      status: "ingest-in-progress";
      connectorIds: string[];
    };

/** Take every lease or none: on the first busy connector, release what was taken. */
function acquireAll(
  connectorIds: readonly string[],
): { ok: true; leases: ConnectorIngestLease[] } | { ok: false; busy: string[] } {
  const leases: ConnectorIngestLease[] = [];
  const busy: string[] = [];
  for (const id of connectorIds) {
    const lease = tryAcquireConnectorIngest(id, REPAIR_HOLDER);
    if (lease) leases.push(lease);
    else busy.push(id);
  }
  if (busy.length === 0) return { ok: true, leases };
  for (const l of leases) l.release();
  return { ok: false, busy };
}

/**
 * Repair `projectId`'s symbol index. Refuses, changing nothing, while any of
 * its repository connections is being ingested; throws `ReindexConflictError`
 * while a symbol embed or a reindex holds the project's lease.
 *
 * Order matters: the missing vectors are re-queued and the embed job runs
 * FIRST, because the job reuses an orphan vector of the active model for a
 * pending symbol with the same content (#2346) and then prunes the rest of
 * them; only the orphans it leaves (another model's) are deleted after it.
 */
export async function repairIndexConsistency(
  projectId: string,
  deps: IndexConsistencyDeps = {},
): Promise<IndexRepairResult> {
  const connections = await prisma.repoConnection.findMany({
    where: { projectId },
    select: { id: true },
  });
  const taken = acquireAll(connections.map((c) => c.id));
  if (!taken.ok) return { status: "ingest-in-progress", connectorIds: taken.busy };
  try {
    return await withSymbolFence(projectId, deps, async (fence) => {
      const fenced = { ...deps, fence };
      const before = await checkIndexConsistency(projectId, fenced);

      for (let i = 0; i < before.missingVectorIds.length; i += UPDATE_CHUNK) {
        if (!(await fence.renew())) throw new ReindexFencedError(projectId, fence.holder);
        await prisma.codeSymbolEmbedding.updateMany({
          where: {
            projectId,
            symbolId: { in: before.missingVectorIds.slice(i, i + UPDATE_CHUNK) },
          },
          data: { embeddingModel: PENDING_MODEL },
        });
      }

      const owed = before.missingVectorIds.length + before.pendingEmbeddings;
      const hasOrphans = before.orphanVectorIds.length > 0;
      const embed =
        owed > 0 || hasOrphans
          ? await (deps.embed ?? embedProjectSymbols)(projectId, fenced)
          : null;

      // What the embed job left: the orphans of another model, which it never sees.
      const middle = hasOrphans ? await checkIndexConsistency(projectId, fenced) : null;
      const leftOrphans = middle?.orphanVectorIds ?? [];
      if (leftOrphans.length > 0) {
        await createSymbolEmbeddingStore(fenced).deleteBySymbolIds(projectId, leftOrphans);
      }

      const after = await checkIndexConsistency(projectId, fenced);
      const result = {
        status: "repaired" as const,
        before: summarizeConsistency(before),
        after: summarizeConsistency(after),
        requeued: before.missingVectorIds.length,
        removedOrphans: before.orphanVectorIds.length - after.orphanVectorIds.length,
        embed,
      };
      log.info("index consistency repaired", {
        projectId,
        before: result.before,
        after: result.after,
        requeued: result.requeued,
        removedOrphans: result.removedOrphans,
      });
      return result;
    });
  } finally {
    for (const l of taken.leases) l.release();
  }
}

/**
 * The check's counts for the index status (#2326), or `null` when it could not
 * run (the vector store unreachable): the status then says so rather than
 * failing.
 */
export async function loadIndexConsistencySummary(
  projectId: string,
  deps: Pick<IndexConsistencyDeps, "store"> = {},
): Promise<IndexConsistencySummary | null> {
  try {
    return summarizeConsistency(await checkIndexConsistency(projectId, deps));
  } catch (err) {
    log.warn("index consistency check failed", {
      projectId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
