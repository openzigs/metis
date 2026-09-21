/**
 * Task handler registry — maps `task.type` discriminators to handler
 * implementations. Built-in handlers cover the v1 job catalogue:
 *
 *   - refresh-repo-connector
 *   - refresh-db-connector-schema
 *   - rerun-analysis
 *   - publish-batch
 *   - publish-generated-document
 *   - http-webhook
 *
 * Each built-in handler is implemented as a thin wrapper that calls into the
 * existing service layer, so unit tests can mock those services without
 * touching the registry itself.
 */
import { createChildLogger } from "../logger.js";
import type { TaskHandlerFn, TaskHandlerRegistration, TaskHandlerRegistry } from "./types.js";
import { regenerationTaskSchema, type RegenerationTask } from "../docs-gen/regeneration-plan.js";

const log = createChildLogger("task-handlers");

export class InMemoryTaskHandlerRegistry implements TaskHandlerRegistry {
  private handlers = new Map<string, TaskHandlerRegistration>();

  register(reg: TaskHandlerRegistration): void {
    if (this.handlers.has(reg.type)) {
      log.warn("Task handler re-registered (overwriting)", { type: reg.type });
    }
    this.handlers.set(reg.type, reg);
  }

  get(type: string): TaskHandlerRegistration | undefined {
    return this.handlers.get(type);
  }

  list(): TaskHandlerRegistration[] {
    return Array.from(this.handlers.values()).sort((a, b) => a.type.localeCompare(b.type));
  }
}

export const BUILT_IN_TASK_TYPES = [
  "refresh-repo-connector",
  "refresh-db-connector-schema",
  "rerun-analysis",
  "publish-batch",
  "publish-generated-document",
  "regenerate-generated-document",
  "http-webhook",
] as const;

export type BuiltInTaskType = (typeof BUILT_IN_TASK_TYPES)[number];

export interface BuiltInHandlerDeps {
  regenerateGeneratedDocument?(payload: RegenerationTask, signal: AbortSignal): Promise<void>;
  /** Webhook handler — injected separately because it needs network policy. */
  httpWebhookHandler: TaskHandlerFn;
  /** Refresh a repo connector by id. */
  refreshRepoConnector?(
    connectorId: string,
    signal: AbortSignal,
  ): Promise<Record<string, unknown> | void>;
  /** Refresh a db connector schema by id. */
  refreshDbConnectorSchema?(
    connectorId: string,
    signal: AbortSignal,
  ): Promise<Record<string, unknown> | void>;
  /** Re-run analysis on a project's documents. */
  rerunAnalysis?(projectId: string, signal: AbortSignal): Promise<Record<string, unknown> | void>;
  /** Publish a saved batch by id. */
  publishBatch?(batchId: string, signal: AbortSignal): Promise<Record<string, unknown> | void>;
  /** Publish a generated document revision into the shared indexing lifecycle. */
  publishGeneratedDocument?(
    generatedDocumentId: string,
    projectId: string,
    version: number,
    revisionId: string,
    signal: AbortSignal,
  ): Promise<Record<string, unknown> | void>;
  /** Run an AI Bug Scanner scan by id (Epic #708). */
  runScannerScan?(scanId: string, signal: AbortSignal): Promise<Record<string, unknown> | void>;
}

/**
 * Register the v1 job catalogue against `registry`. Handlers that depend on
 * services not yet wired (in tests, for example) report a clear error rather
 * than crashing.
 */
export function registerBuiltInHandlers(
  registry: TaskHandlerRegistry,
  deps: BuiltInHandlerDeps,
): void {
  registry.register({
    type: "regenerate-generated-document",
    description: "Regenerate changed inputs using the original production generation path.",
    defaultTimeoutMs: 7_200_000,
    handler: async (ctx) => {
      const payload = regenerationTaskSchema.parse(ctx.task.payload);
      if (ctx.task.projectId !== payload.projectId)
        throw new Error("Regeneration project mismatch");
      if (!deps.regenerateGeneratedDocument)
        throw new Error("regenerate-generated-document handler not wired");
      await deps.regenerateGeneratedDocument(payload, ctx.signal);
      return { generatedDocumentId: payload.generatedDocumentId };
    },
  });
  registry.register({
    type: "refresh-repo-connector",
    description: "Re-pull metadata + re-ingest a repo connector into the RAG index.",
    handler: async (ctx) => {
      const connectorId = String(ctx.task.payload.connectorId ?? "");
      if (!connectorId) throw new Error("payload.connectorId is required");
      ctx.reportProgress({ step: "refresh-repo-connector:start" });
      if (!deps.refreshRepoConnector) {
        throw new Error("refresh-repo-connector handler not wired");
      }
      const result = (await deps.refreshRepoConnector(connectorId, ctx.signal)) ?? {};
      ctx.reportProgress({ step: "refresh-repo-connector:complete", pct: 100 });
      return { connectorId, ...result };
    },
  });

  registry.register({
    type: "refresh-db-connector-schema",
    description: "Re-introspect schema + refresh sample rows for a database connector.",
    handler: async (ctx) => {
      const connectorId = String(ctx.task.payload.connectorId ?? "");
      if (!connectorId) throw new Error("payload.connectorId is required");
      ctx.reportProgress({ step: "refresh-db-connector-schema:start" });
      if (!deps.refreshDbConnectorSchema) {
        throw new Error("refresh-db-connector-schema handler not wired");
      }
      const result = (await deps.refreshDbConnectorSchema(connectorId, ctx.signal)) ?? {};
      ctx.reportProgress({ step: "refresh-db-connector-schema:complete", pct: 100 });
      return { connectorId, ...result };
    },
  });

  registry.register({
    type: "rerun-analysis",
    description:
      "Trigger Phase 7 analysis on a project's documents with the current default agents.",
    handler: async (ctx) => {
      const projectId = String(ctx.task.payload.projectId ?? ctx.task.projectId ?? "");
      if (!projectId) throw new Error("payload.projectId is required");
      ctx.reportProgress({ step: "rerun-analysis:start" });
      if (!deps.rerunAnalysis) {
        throw new Error("rerun-analysis handler not wired");
      }
      const result = (await deps.rerunAnalysis(projectId, ctx.signal)) ?? {};
      ctx.reportProgress({ step: "rerun-analysis:complete", pct: 100 });
      return { projectId, ...result };
    },
  });

  registry.register({
    type: "publish-batch",
    description: "Trigger Phase 9 publish on a saved batch (idempotent re-publish).",
    handler: async (ctx) => {
      const batchId = String(ctx.task.payload.batchId ?? "");
      if (!batchId) throw new Error("payload.batchId is required");
      ctx.reportProgress({ step: "publish-batch:start" });
      if (!deps.publishBatch) {
        throw new Error("publish-batch handler not wired");
      }
      const result = (await deps.publishBatch(batchId, ctx.signal)) ?? {};
      ctx.reportProgress({ step: "publish-batch:complete", pct: 100 });
      return { batchId, ...result };
    },
  });

  registry.register({
    type: "publish-generated-document",
    description: "Publish a generated-document revision through the shared indexing lifecycle.",
    handler: async (ctx) => {
      const generatedDocumentId = String(ctx.task.payload.generatedDocumentId ?? "");
      const projectId = String(ctx.task.payload.projectId ?? ctx.task.projectId ?? "");
      const version = Number(ctx.task.payload.version ?? Number.NaN);
      const revisionId = String(ctx.task.payload.revisionId ?? "");
      if (!generatedDocumentId) throw new Error("payload.generatedDocumentId is required");
      if (!projectId) throw new Error("payload.projectId is required");
      if (!Number.isInteger(version) || version < 1) {
        throw new Error("payload.version must be a positive integer");
      }
      if (!revisionId) throw new Error("payload.revisionId is required");
      ctx.reportProgress({ step: "publish-generated-document:start" });
      if (!deps.publishGeneratedDocument) {
        throw new Error("publish-generated-document handler not wired");
      }
      const result =
        (await deps.publishGeneratedDocument(
          generatedDocumentId,
          projectId,
          version,
          revisionId,
          ctx.signal,
        )) ?? {};
      ctx.reportProgress({ step: "publish-generated-document:complete", pct: 100 });
      return { generatedDocumentId, projectId, version, revisionId, ...result };
    },
  });

  registry.register({
    type: "http-webhook",
    description: "POST a JSON payload to a vetted external webhook URL.",
    handler: deps.httpWebhookHandler,
  });

  registry.register({
    type: "scanner.run-scan",
    description: "Run an AI Bug Scanner scan against a project's repo (Epic #708).",
    handler: async (ctx) => {
      const scanId = String(ctx.task.payload.scanId ?? "");
      if (!scanId) throw new Error("payload.scanId is required");
      ctx.reportProgress({ step: "scanner.run-scan:start" });
      if (!deps.runScannerScan) {
        throw new Error("scanner.run-scan handler not wired");
      }
      const result = (await deps.runScannerScan(scanId, ctx.signal)) ?? {};
      ctx.reportProgress({ step: "scanner.run-scan:complete", pct: 100 });
      return { scanId, ...result };
    },
  });
}
