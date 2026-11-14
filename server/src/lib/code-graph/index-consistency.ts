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
 * job runs) and removes the orphans, under the project's reindex fence, which
 * every writer of the symbol vectors takes. Commit drift is reported only: a
 * re-sync of the repository fixes it. Run again, the repair finds nothing to do.
 *
 * What a repair can and cannot see of a running ingest (#2346 review). Its only
 * production caller is the `index:consistency` CLI, a process of its own, so:
 *
 *   - it refuses while the DATABASE records a running source ingest of one of
 *     the project's live connections (`repo_connections.sourceIngestState`,
 *     heartbeat fresh: `effectiveSourceIngestStatus`), which any process sees;
 *   - it holds every connection's ingest lease (`ingest-guard.ts`), which only
 *     excludes ingests in the same process: none, from the CLI;
 *   - the reindex fence excludes the symbol embed job of any replica on
 *     Postgres, where it is a database row; on SQLite it is in-process only.
 *
 * A sync's code-graph step runs BEFORE its source ingest records anything, and
 * leaves no record of its own, so a repair overlapping that step is not
 * refused. Traced, the overlap is bounded: the vectors of symbols the ingest
 * just deleted are removed a step early (the embed job prunes them anyway), and
 * a re-queued row the ingest also rewrote is embedded once more. Nothing a
 * search needs is lost. Operators run `--repair` when no sync of the project is
 * in progress (`docs/OPERATIONS.md`).
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
  effectiveSourceIngestStatus,
  parseSourceIngestState,
} from "../connectors/source-ingest-state.js";
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
  const ns = symbolVectorsId(projectId);
  const [refs, rows, graphs, symbolCounts] = await Promise.all([
    // Ids and model tags only: on Lance `listChunkRefs` reads every vector and
    // text, and `get_index_status` runs this check per call (#2346 review).
    store.listChunkModels ? store.listChunkModels(ns) : store.listChunkRefs(ns),
    prisma.codeSymbolEmbedding.findMany({
      where: { projectId },
      select: { symbolId: true, embeddingModel: true },
    }),
    prisma.codeGraph.findMany({
      // A deleted connection's graph is no repository's current index, and a
      // re-sync, the documented fix for drift, cannot reach it.
      where: { projectId, repoConnectionId: { not: null }, repoConnection: { deletedAt: null } },
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
      /**
       * A repository connection of the project is being ingested, as the database
       * records it or as this process's ingest lease shows: nothing was changed.
       */
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
 * The project's live connections whose source ingest the database records as
 * running, heartbeat fresh: visible from any process, unlike the ingest lease.
 * A run whose process died goes stale (`SOURCE_INGEST_STALE_MS`) and stops
 * blocking.
 */
function recordedRunning(
  connections: ReadonlyArray<{
    id: string;
    deletedAt: Date | null;
    sourceIngestState: string | null;
  }>,
  now: number,
): string[] {
  return connections
    .filter((c) => c.deletedAt === null)
    .filter((c) => {
      const state = parseSourceIngestState(c.sourceIngestState);
      return state !== null && effectiveSourceIngestStatus(state, now) === "running";
    })
    .map((c) => c.id);
}

/**
 * Repair `projectId`'s symbol index. Refuses, changing nothing, while the
 * database records a running source ingest of one of its repository
 * connections, or this process holds one's ingest lease; throws
 * `ReindexConflictError` while a symbol embed or a reindex holds the project's
 * lease. What this cannot see is in the module header.
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
    select: { id: true, deletedAt: true, sourceIngestState: true },
  });
  const running = recordedRunning(connections, Date.now());
  if (running.length > 0) return { status: "ingest-in-progress", connectorIds: running };
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
