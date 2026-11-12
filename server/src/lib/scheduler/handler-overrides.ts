/**
 * Wire-up for the Phase 11 task handler catalogue (review finding H4).
 *
 * The scheduler bootstrap accepts a `BuiltInHandlerDeps` object; without
 * overrides four of the five built-ins throw `"<type> handler not wired"` at
 * fire-time. This module produces real implementations bound to the live
 * service layer:
 *
 *   - refresh-repo-connector       → runRepoConnectorRefresh (connectors/repo/repo-refresh.ts)
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
import { SYSTEM_ACTOR_ID } from "../audit/system-actor.js";
import {
  publishGeneratedDocRevision,
  settleCancelledGeneratedDocPublication,
} from "../docs-gen/generated-doc-publication.js";
import { inspectDbConnector } from "../connectors/db/db-service.js";
import { ingestDbSchema } from "../connectors/connector-ingest.js";
import { acquireOrQueueConnectorIngest } from "../connectors/ingest-guard.js";
import { runRepoConnectorRefresh } from "../connectors/repo/repo-refresh.js";
import { runBatch } from "../publishing/publisher.js";
import { AnalysisOrchestrator, getOrchestrator } from "../analysis/orchestrator.js";
import { buildProvider, loadAIConfig } from "../ai/index.js";
import { prisma } from "../prisma.js";
import { runAutopilot } from "../autopilot/index.js";
import type { BuiltInHandlerDeps } from "./task-handlers.js";
import { runRegenerationTask } from "../docs-gen/incremental.js";
import { retryRegenerationScheduling } from "../docs-gen/regeneration-scheduling.js";

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
    retryRegenerationScheduling,
    refreshRepoConnector:
      opts.refreshRepoConnector ??
      (async (connectorId, signal) => {
        abortGuard(signal);
        // #217 — the per-connector ingest guard shared with the sync routes and the
        // eval runner. #2335 — a refresh that finds a sync running no longer fails
        // (409): it folds into that connector's single queued re-run, which runs
        // once the current one ends.
        const claim = acquireOrQueueConnectorIngest(connectorId, "scheduled-refresh", {
          trigger: "scheduled",
        });
        if ("queued" in claim) return { connectorId, queued: true, trigger: "scheduled" };
        return runRepoConnectorRefresh(connectorId, claim.lease, signal);
      }),
    refreshDbConnectorSchema:
      opts.refreshDbConnectorSchema ??
      (async (connectorId, signal) => {
        abortGuard(signal);
        const projectId = await fetchDbConnectorProjectId(connectorId);
        const snap = await inspectDbConnector(projectId, connectorId, SYSTEM_ACTOR_ID);
        abortGuard(signal);
        // Re-ingest the fresh snapshot so the RAG knowledge base stays current.
        // Without this the scheduled refresh only introspects and discards the
        // result — chat/analysis schema context goes stale.
        const ingestSummary = await ingestDbSchema(projectId, connectorId, SYSTEM_ACTOR_ID, snap);
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
            run: async () => orchestrator.start({ projectId, startedById: SYSTEM_ACTOR_ID }),
          });
          if (out.status === "aborted") {
            throw new Error(`autopilot ${out.reason ?? "aborted"}`);
          }
          const started = out.result as { id: string };
          return { analysisId: started.id };
        }
        const started = await orchestrator.start({
          projectId,
          startedById: SYSTEM_ACTOR_ID,
        });
        return { analysisId: started.id };
      }),
    publishBatch:
      opts.publishBatch ??
      (async (batchId, signal) => {
        abortGuard(signal);
        // #504 — a scheduled republish is handed NO credential: `runBatch`
        // does not read the batch's `metadata.secretRef` / `metadata.secretId`
        // (#480), and there is no per-target secret to fall back to. So the
        // live publish step fails with `TOKEN_REQUIRED` rather than using the
        // secret bound by whoever created the batch, on behalf of whoever
        // scheduled the task. Re-running a batch with its bound secret goes
        // through `executeBatch` (the batch execute route).
        const result = await runBatch({
          batchId,
          dryRun: false,
          secretRef: null,
        });
        return { batchId, status: result.status };
      }),
    publishGeneratedDocument:
      opts.publishGeneratedDocument ??
      (async (generatedDocumentId, projectId, version, revisionId, signal, options) => {
        abortGuard(signal);
        const result = await publishGeneratedDocRevision(
          {
            generatedDocumentId,
            projectId,
            version,
            revisionId,
          },
          { signal, onProgress: options?.onProgress, finalAttempt: options?.finalAttempt },
        );
        abortGuard(signal);
        return result;
      }),
    settleCancelledGeneratedDocPublication,
  };
}
