/**
 * Wire-up for the Phase 11 task handler catalogue (review finding H4).
 *
 * The scheduler bootstrap accepts a `BuiltInHandlerDeps` object; without
 * overrides four of the five built-ins throw `"<type> handler not wired"` at
 * fire-time. This module produces real implementations bound to the live
 * service layer:
 *
 *   - refresh-repo-connector       → fetchRepoMetadata + testRepoConnector
 *   - refresh-db-connector-schema  → inspectDbConnector + ingestDbSchema
 *   - rerun-analysis               → AnalysisOrchestrator.start
 *   - publish-batch                → publishing.runBatch
 *   - http-webhook                 → already wired by bootstrapScheduler
 *
 * Each handler accepts an `AbortSignal` and threads it through where the
 * downstream service supports it. The signal is observed best-effort: when
 * the underlying service does not yet honour cancellation we throw a
 * `signal.aborted` check before returning so an in-flight cancel never sees
 * a stale "completed" status.
 */
import {
  fetchRepoMetadata,
  pullOrCloneRepo,
  testRepoConnector,
} from "../connectors/repo/repo-service.js";
import { publishGeneratedDocRevision } from "../docs-gen/generated-doc-publication.js";
import { buildCodeGraphSchemaWiring, inspectDbConnector } from "../connectors/db/db-service.js";
import {
  ingestDbSchema,
  ingestRepoMetadata,
  ingestSourceAsKnowledge,
} from "../connectors/connector-ingest.js";
import { ingestCodeGraph } from "../code-graph/ingest.js";
import { runBatch } from "../publishing/publisher.js";
import { AnalysisOrchestrator, getOrchestrator } from "../analysis/orchestrator.js";
import { buildProvider, loadAIConfig } from "../ai/index.js";
import { prisma } from "../prisma.js";
import { runAutopilot } from "../autopilot/index.js";
import type { BuiltInHandlerDeps } from "./task-handlers.js";
import { checkIncrementalRegeneration, runRegenerationTask } from "../docs-gen/incremental.js";

async function fetchRepoConnectorProjectId(connectorId: string): Promise<string> {
  const row = await prisma.repoConnection.findUnique({ where: { id: connectorId } });
  if (!row) throw new Error(`repo connector ${connectorId} not found`);
  return row.projectId;
}

async function fetchDbConnectorProjectId(connectorId: string): Promise<string> {
  const row = await prisma.databaseConnection.findUnique({ where: { id: connectorId } });
  if (!row) throw new Error(`db connector ${connectorId} not found`);
  return row.projectId;
}

function abortGuard(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error("aborted");
  }
}

let analysisOrchestratorOverride: AnalysisOrchestrator | null = null;

/** Test seam — inject a stub orchestrator so handler tests don't spin AI. */
export function __setAnalysisOrchestratorForHandlers(o: AnalysisOrchestrator | null): void {
  analysisOrchestratorOverride = o;
}

function getAnalysisOrchestrator(): AnalysisOrchestrator {
  if (analysisOrchestratorOverride) return analysisOrchestratorOverride;
  try {
    return getOrchestrator();
  } catch {
    const provider = buildProvider({ config: loadAIConfig() });
    return getOrchestrator({ provider });
  }
}

export interface SchedulerHandlerWiringOpts {
  /** Override for unit tests. */
  refreshRepoConnector?: BuiltInHandlerDeps["refreshRepoConnector"];
  refreshDbConnectorSchema?: BuiltInHandlerDeps["refreshDbConnectorSchema"];
  rerunAnalysis?: BuiltInHandlerDeps["rerunAnalysis"];
  publishBatch?: BuiltInHandlerDeps["publishBatch"];
  publishGeneratedDocument?: BuiltInHandlerDeps["publishGeneratedDocument"];
}

export function buildSchedulerHandlerOverrides(
  opts: SchedulerHandlerWiringOpts = {},
): Partial<BuiltInHandlerDeps> {
  return {
    regenerateGeneratedDocument: runRegenerationTask,
    refreshRepoConnector:
      opts.refreshRepoConnector ??
      (async (connectorId, signal) => {
        abortGuard(signal);
        const projectId = await fetchRepoConnectorProjectId(connectorId);
        // Step 1 — pull latest commits (or re-clone if clone is missing/corrupt)
        const clone = await pullOrCloneRepo(projectId, connectorId, "system");
        abortGuard(signal);
        // Step 2 — incremental code-graph re-ingest (only changed files).
        // Best-effort SQL-lineage wiring from the project's DB connector
        // (#316/#317); never blocks the scheduled refresh if unavailable.
        const schemaWiring = await buildCodeGraphSchemaWiring(projectId, "system");
        const graphStats = await ingestCodeGraph(prisma, {
          projectId,
          rootDir: clone.path,
          repoConnectionId: connectorId,
          introspectedSchema: schemaWiring.introspectedSchema,
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
          "system",
          clone.path,
        );
        abortGuard(signal);
        // Step 4 — refresh metadata (README, head SHA, connectivity check)
        const meta = await fetchRepoMetadata(projectId, connectorId, "system");
        const metadataSummary = await ingestRepoMetadata(projectId, connectorId, "system", meta);
        abortGuard(signal);
        const test = await testRepoConnector(projectId, connectorId, "system");
        if (srcSummary.failures === 0 && metadataSummary.failures === 0) {
          await checkIncrementalRegeneration(projectId, connectorId);
        }
        return {
          repo: meta.repo.full_name,
          headSha: meta.headSha,
          latencyMs: test.latencyMs,
          pulled: clone.pulled,
          filesChanged: clone.filesChanged,
          filesParsed: graphStats.filesParsed,
          symbolsUpserted: graphStats.symbolsUpserted,
          chunksIngested: srcSummary.chunkCount,
        };
      }),
    refreshDbConnectorSchema:
      opts.refreshDbConnectorSchema ??
      (async (connectorId, signal) => {
        abortGuard(signal);
        const projectId = await fetchDbConnectorProjectId(connectorId);
        const snap = await inspectDbConnector(projectId, connectorId, "system");
        abortGuard(signal);
        // Re-ingest the fresh snapshot so the RAG knowledge base stays current.
        // Without this the scheduled refresh only introspects and discards the
        // result — chat/analysis schema context goes stale.
        const ingestSummary = await ingestDbSchema(projectId, connectorId, "system", snap);
        return {
          tableCount: snap.tables.length,
          durationMs: snap.durationMs,
          chunksIngested: ingestSummary.chunkCount,
        };
      }),
    rerunAnalysis:
      opts.rerunAnalysis ??
      (async (projectId, signal) => {
        abortGuard(signal);
        const project = await prisma.project.findUnique({
          where: { id: projectId },
          select: { autopilotEnabled: true },
        });
        const orchestrator = getAnalysisOrchestrator();
        // Epic #164 — when the project is in autopilot mode, wrap the
        // scheduled run with the FinOps + safety rails (budget gate + cost
        // ceiling watchdog + lifecycle audit). Direct/manual `/run` calls
        // bypass this so admins can still kick off ad-hoc runs.
        if (project?.autopilotEnabled) {
          const out = await runAutopilot({
            projectId,
            triggeredBy: "scheduler",
            run: async () => orchestrator.start({ projectId, startedById: "system" }),
          });
          if (out.status === "aborted") {
            throw new Error(`autopilot ${out.reason ?? "aborted"}`);
          }
          const started = out.result as { id: string };
          return { analysisId: started.id };
        }
        const started = await orchestrator.start({
          projectId,
          startedById: "system",
        });
        return { analysisId: started.id };
      }),
    publishBatch:
      opts.publishBatch ??
      (async (batchId, signal) => {
        abortGuard(signal);
        // Republish runs in dry-run=false mode and pulls its own secrets via
        // vault refs configured on the batch's PublishTarget.
        const result = await runBatch({
          batchId,
          dryRun: false,
          // Vault ref is resolved inside the publisher via batch metadata;
          // null here forces it to consult the configured target.
          secretRef: null,
        });
        return { batchId, status: result.status };
      }),
    publishGeneratedDocument:
      opts.publishGeneratedDocument ??
      (async (generatedDocumentId, projectId, version, revisionId, signal) => {
        abortGuard(signal);
        const result = await publishGeneratedDocRevision(
          {
            generatedDocumentId,
            projectId,
            version,
            revisionId,
          },
          { signal },
        );
        abortGuard(signal);
        return result;
      }),
  };
}
