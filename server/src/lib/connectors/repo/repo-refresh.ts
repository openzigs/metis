/**
 * #2335 — the unattended incremental refresh of one repository connector,
 * shared by the scheduled `refresh-repo-connector` task and the queued
 * follow-up runs (`refresh-trigger.ts`: push webhook, signed CI call, and the
 * re-run a sync requested while another ran). Moved verbatim from the
 * scheduler's handler wiring, plus the `local`/`upload` branch the manual
 * Sync route already has, so a queued re-run of a manual Sync on such a
 * connector works too.
 *
 * Runs as the system actor and never reads anything from a webhook: git pulls
 * the connector's own configured branch with argument arrays inside
 * `pullOrCloneRepo`.
 */
import { REPO_PROVIDER_LOCAL, REPO_PROVIDER_UPLOAD } from "@metis/shared";
import { SYSTEM_ACTOR_ID } from "../../audit/system-actor.js";
import { prisma } from "../../prisma.js";
import { ingestCodeGraph } from "../../code-graph/ingest.js";
import { scheduleIncrementalRegeneration } from "../../docs-gen/regeneration-scheduling.js";
import { buildCodeGraphSchemaWiring } from "../db/db-service.js";
import { ingestRepoMetadata, ingestSourceAsKnowledge } from "../connector-ingest.js";
import { assertConnectorIngestLease, type ConnectorIngestLease } from "../ingest-guard.js";
import {
  fetchRepoMetadata,
  pullOrCloneRepo,
  resolveNonGitIngestRoot,
  testRepoConnector,
} from "./repo-service.js";

function abortGuard(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error("aborted");
  }
}

async function fetchRepoConnector(
  connectorId: string,
): Promise<{ projectId: string; provider: string }> {
  const row = await prisma.repoConnection.findUnique({ where: { id: connectorId } });
  if (!row) throw new Error(`repo connector ${connectorId} not found`);
  return { projectId: row.projectId, provider: row.provider };
}

/**
 * Pull (or re-clone), then incrementally re-ingest the code graph, the source
 * knowledge and the metadata, and schedule regeneration. The caller has taken
 * `lease` for `connectorId`; it is released here when the run ends, which is
 * what hands a queued follow-up its turn (`ingest-guard.ts`).
 */
export async function runRepoConnectorRefresh(
  connectorId: string,
  lease: ConnectorIngestLease,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  try {
    assertConnectorIngestLease(lease, connectorId);
    abortGuard(signal);
    const { projectId, provider } = await fetchRepoConnector(connectorId);
    const isNonGit = provider === REPO_PROVIDER_LOCAL || provider === REPO_PROVIDER_UPLOAD;
    // Step 1 — pull latest commits (or re-clone if clone is missing/corrupt);
    // `local`/`upload` re-resolve their validated directory instead.
    let boundary: string | undefined;
    let clone: {
      path: string;
      pulled: boolean;
      filesChanged: number;
      commitSha?: string | null;
    };
    if (isNonGit) {
      const root = await resolveNonGitIngestRoot(projectId, connectorId);
      clone = { path: root.path, pulled: false, filesChanged: 0 };
      boundary = root.boundary;
    } else {
      clone = await pullOrCloneRepo(projectId, connectorId, SYSTEM_ACTOR_ID);
    }
    abortGuard(signal);
    // Step 2 — incremental code-graph re-ingest (only changed files).
    // Best-effort SQL-lineage wiring from the project's DB connector
    // (#316/#317); never blocks the scheduled refresh if unavailable.
    const schemaWiring = await buildCodeGraphSchemaWiring(projectId, SYSTEM_ACTOR_ID);
    const graphStats = await ingestCodeGraph(prisma, {
      projectId,
      rootDir: clone.path,
      repoConnectionId: connectorId,
      // #714/#758 — label the graph with the pulled commit; ingestCodeGraph
      // records it as lastCommitSha too, once the graph is complete.
      commitSha: clone.commitSha ?? undefined,
      introspectedSchema: schemaWiring.introspectedSchema,
      introspectionFailed: schemaWiring.introspectionFailed,
      routines: schemaWiring.routines,
      fetchRoutineBody: schemaWiring.fetchRoutineBody,
      routineDialect: schemaWiring.routineDialect,
      packages: schemaWiring.packages,
      fetchPackageBody: schemaWiring.fetchPackageBody,
      dependencies: schemaWiring.dependencies,
      sqlLineageOverride: schemaWiring.sqlLineageOverride,
      embedSymbols: true, // #797 — the scheduled refresh re-embeds changed symbols
    });
    abortGuard(signal);
    // Step 3 — incremental RAG knowledge ingest
    const srcSummary = await ingestSourceAsKnowledge(
      projectId,
      connectorId,
      SYSTEM_ACTOR_ID,
      clone.path,
      { boundary, lease },
    );
    abortGuard(signal);
    if (isNonGit) {
      // No remote to read metadata or test connectivity against.
      const scheduling =
        srcSummary.failures === 0
          ? await scheduleIncrementalRegeneration(projectId, connectorId)
          : null;
      if (scheduling && !scheduling.regenerationScheduled && !scheduling.retryQueued)
        throw new Error(scheduling.warning);
      return {
        pulled: false,
        filesChanged: 0,
        filesParsed: graphStats.filesParsed,
        symbolsUpserted: graphStats.symbolsUpserted,
        chunksIngested: srcSummary.chunkCount,
        ...(scheduling && !scheduling.regenerationScheduled
          ? { regenerationScheduled: false, warning: scheduling.warning }
          : {}),
      };
    }
    // Step 4 — refresh metadata (README, manifests, connectivity check)
    const meta = await fetchRepoMetadata(projectId, connectorId, SYSTEM_ACTOR_ID);
    const metadataSummary = await ingestRepoMetadata(projectId, connectorId, SYSTEM_ACTOR_ID, meta);
    abortGuard(signal);
    const test = await testRepoConnector(projectId, connectorId, SYSTEM_ACTOR_ID);
    // #449 — a scheduling failure no longer fails the refresh: the ingest
    // landed, and a `schedule-regeneration` task retries the scheduling
    // alone. Only when that retry could not be queued does the refresh
    // fail, so the task queue's own retry is the fallback.
    const scheduling =
      srcSummary.failures === 0 && metadataSummary.failures === 0
        ? await scheduleIncrementalRegeneration(projectId, connectorId)
        : null;
    if (scheduling && !scheduling.regenerationScheduled && !scheduling.retryQueued)
      throw new Error(scheduling.warning);
    return {
      repo: meta.repo.full_name,
      headSha: meta.headSha,
      latencyMs: test.latencyMs,
      pulled: clone.pulled,
      filesChanged: clone.filesChanged,
      filesParsed: graphStats.filesParsed,
      // #856 — a same-SHA refresh that still did work says why: a lineage
      // backfill re-extracts lineage without re-parsing (filesParsed 0).
      lineageBackfill: graphStats.lineageBackfill,
      filesLineageRefreshed: graphStats.filesLineageRefreshed,
      symbolsUpserted: graphStats.symbolsUpserted,
      chunksIngested: srcSummary.chunkCount,
      ...(scheduling && !scheduling.regenerationScheduled
        ? { regenerationScheduled: false, warning: scheduling.warning }
        : {}),
    };
  } finally {
    lease.release();
  }
}
