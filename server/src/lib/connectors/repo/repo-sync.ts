/**
 * #2335 panel — the body of a manual **Sync** (`POST /repos/:id/refresh-ingest`),
 * shared by the route and by the queued re-run of a Sync that was asked for
 * while another run held the connector. Both do exactly the same work:
 *
 *   pull (or re-resolve a `local`/`upload` root) → incremental code graph →
 *   incremental source knowledge → metadata (a `fetchRepoMetadata` failure is
 *   logged and the sync carries on) → database-connection discovery and its
 *   notification → regeneration scheduling.
 *
 * The caller holds the connector's ingest lease and releases it; this function
 * never does.
 *
 * Push-triggered and scheduled refreshes deliberately keep the unattended
 * refresh in `repo-refresh.ts`: it does the work the scheduled task always
 * did, and an externally signed push does not widen into the discovery scan
 * (which can read credentials out of the clone when a project allows it).
 */
import { REPO_PROVIDER_LOCAL, REPO_PROVIDER_UPLOAD } from "@metis/shared";
import { SYSTEM_ACTOR_ID } from "../../audit/system-actor.js";
import { ingestCodeGraph } from "../../code-graph/ingest.js";
import { scheduleIncrementalRegeneration } from "../../docs-gen/regeneration-scheduling.js";
import { createChildLogger } from "../../logger.js";
import { prisma } from "../../prisma.js";
import { ingestRepoMetadata, ingestSourceAsKnowledge } from "../connector-ingest.js";
import { buildCodeGraphSchemaWiring } from "../db/db-service.js";
import { assertConnectorIngestLease, type ConnectorIngestLease } from "../ingest-guard.js";
import { discoverAndUpsertConnections } from "./connection-discovery.js";
import { deepIngestFailureCount, syncFailureWarning } from "./deep-ingest-outcome.js";
import {
  fetchRepoMetadata,
  getRepoConnector,
  getRepoConnectorEmitter,
  pullOrCloneRepo,
  resolveNonGitIngestRoot,
} from "./repo-service.js";

const logger = createChildLogger("connector-ingest");

function abortGuard(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("aborted");
}

export interface RepoSyncOptions {
  /** The connector's provider, as the caller read it with the connector. */
  provider: string;
  /** Held by the caller for `connectorId`; released by the caller. */
  lease: ConnectorIngestLease;
  /** Checked between steps (the queued re-run passes the server's shutdown signal). */
  signal?: AbortSignal;
}

/** One manual Sync of a repository connector; returns the Sync summary the route answers with. */
export async function runRepoConnectorSync(
  projectId: string,
  id: string,
  a: string,
  { provider, lease, signal }: RepoSyncOptions,
) {
  assertConnectorIngestLease(lease, id);
  abortGuard(signal);
  // Step 1: github pulls (or re-clones); local re-validates path; upload
  // re-extracts the stored archive. Both non-git providers skip the clone.
  const isNonGit = provider === REPO_PROVIDER_LOCAL || provider === REPO_PROVIDER_UPLOAD;
  let clone: {
    path: string;
    sizeBytes: number;
    pulled: boolean;
    filesChanged: number;
    commitSha?: string | null;
  };
  let boundary: string | undefined;
  if (isNonGit) {
    const root = await resolveNonGitIngestRoot(projectId, id);
    clone = { path: root.path, sizeBytes: 0, pulled: false, filesChanged: 0 };
    boundary = root.boundary;
  } else {
    clone = await pullOrCloneRepo(projectId, id, a);
  }
  abortGuard(signal);
  // Step 2: incremental code-graph — only changed files are re-parsed.
  // Best-effort SQL-lineage wiring from the project's DB connector
  // (#316/#317); never blocks ingest if unavailable.
  const refreshSchemaWiring = await buildCodeGraphSchemaWiring(projectId, a);
  const stats = await ingestCodeGraph(prisma, {
    projectId,
    rootDir: clone.path,
    repoConnectionId: id,
    // #714/#758 — label the graph with the pulled commit; ingestCodeGraph
    // records it as lastCommitSha too, once the graph is complete.
    commitSha: clone.commitSha ?? undefined,
    triggeredByUserId: a,
    introspectedSchema: refreshSchemaWiring.introspectedSchema,
    introspectionFailed: refreshSchemaWiring.introspectionFailed,
    routines: refreshSchemaWiring.routines,
    fetchRoutineBody: refreshSchemaWiring.fetchRoutineBody,
    routineDialect: refreshSchemaWiring.routineDialect,
    packages: refreshSchemaWiring.packages,
    fetchPackageBody: refreshSchemaWiring.fetchPackageBody,
    dependencies: refreshSchemaWiring.dependencies,
    sqlLineageOverride: refreshSchemaWiring.sqlLineageOverride,
    embedSymbols: true, // #797 — a refresh keeps symbol vectors current
  });
  abortGuard(signal);
  // Step 3: incremental RAG knowledge ingest
  const srcSummary = await ingestSourceAsKnowledge(projectId, id, a, clone.path, {
    boundary,
    lease,
  });
  abortGuard(signal);
  // Step 4: refresh metadata (README, etc.) — github only
  const metadata = { failures: 0, stepFailed: false };
  if (!isNonGit) {
    try {
      const meta = await fetchRepoMetadata(projectId, id, a);
      const summary = await ingestRepoMetadata(projectId, id, a, meta);
      metadata.failures = summary.failures;
    } catch (metaErr) {
      metadata.stepFailed = true;
      logger.warn("fetchRepoMetadata failed — skipping metadata ingest, core ingest continues", {
        err: metaErr,
        projectId,
        connectorId: id,
      });
    }
  }
  // Step 5: re-scan for database connection references (epic #467)
  const discovery = await discoverAndUpsertConnections(projectId, clone.path);
  // Step 6: emit discovery notification via Socket.IO (#669).
  if (discovery.connectionsFound > 0) {
    const connector = await getRepoConnector(projectId, id);
    getRepoConnectorEmitter().discovery({
      projectId,
      connectorId: id,
      repoLabel: connector.label,
      connectionsFound: discovery.connectionsFound,
    });
  }
  // #498 — a partly failed ingest skips regeneration and says so, with
  // its failure count, as Deep Ingest does; never a bare "Sync complete".
  const ingestFailures = { source: srcSummary, metadata };
  const ingestWarning = syncFailureWarning(ingestFailures);
  // #449 — the refresh landed, so a scheduling failure still answers 200:
  // the summary says regeneration was not scheduled and carries the
  // warning, and the scheduling step alone is retried.
  const scheduling =
    ingestWarning === null ? await scheduleIncrementalRegeneration(projectId, id) : null;
  const warning =
    ingestWarning ?? (scheduling && !scheduling.regenerationScheduled ? scheduling.warning : null);
  return {
    pulled: clone.pulled,
    filesChanged: clone.filesChanged,
    codeGraph: {
      filesScanned: stats.filesScanned,
      filesParsed: stats.filesParsed,
      filesSkipped: stats.filesSkipped,
      symbolsUpserted: stats.symbolsUpserted,
      edgesUpserted: stats.edgesUpserted,
      // #715 — the graph's size, so the Sync panel can tell it apart
      // from the incremental delta above.
      filesUnchanged: stats.filesUnchanged,
      graphFiles: stats.graphFiles,
      graphSymbols: stats.graphSymbols,
      graphEdges: stats.graphEdges,
      durationMs: stats.durationMs,
      // #1071 — set when the time ceiling left Go calls unbound by
      // type; the Sync panel says so, and the next Sync continues.
      goBindingIncomplete: stats.goBinding?.incomplete ?? null,
    },
    sourceKnowledge: {
      documentsCreated: srcSummary.documentsCreated,
      documentsUpdated: srcSummary.documentsUpdated,
      chunkCount: srcSummary.chunkCount,
    },
    suggestedConnectors: {
      filesScanned: discovery.filesScanned,
      connectionsFound: discovery.connectionsFound,
      suggestionsUpserted: discovery.suggestionsUpserted,
    },
    cloneSizeBytes: clone.sizeBytes,
    regenerationScheduled: scheduling?.regenerationScheduled ?? false,
    // Ingest failures, plus one for a scheduling warning (as Deep Ingest reports).
    failureCount:
      deepIngestFailureCount(ingestFailures) +
      (scheduling && !scheduling.regenerationScheduled ? 1 : 0),
    ...(warning ? { warning } : {}),
  };
}

export type RepoConnectorSyncSummary = Awaited<ReturnType<typeof runRepoConnectorSync>>;

/**
 * The queued re-run of a manual Sync: the same work as the route, as the
 * system actor (the marker folds many requests and keeps no requester). A
 * connector deleted while the re-run waited is refused by `getRepoConnector`
 * (404), as Sync would refuse it. Releases `lease` when done.
 */
export async function runQueuedRepoConnectorSync(
  connectorId: string,
  lease: ConnectorIngestLease,
  signal: AbortSignal,
): Promise<RepoConnectorSyncSummary> {
  try {
    assertConnectorIngestLease(lease, connectorId);
    abortGuard(signal);
    const row = await prisma.repoConnection.findUnique({
      where: { id: connectorId },
      select: { projectId: true },
    });
    if (!row) throw new Error(`repo connector ${connectorId} not found`);
    const conn = await getRepoConnector(row.projectId, connectorId);
    return await runRepoConnectorSync(row.projectId, connectorId, SYSTEM_ACTOR_ID, {
      provider: conn.provider,
      lease,
      signal,
    });
  } finally {
    lease.release();
  }
}
