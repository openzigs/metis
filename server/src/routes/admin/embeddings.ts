/**
 * Epic #930 / issue #931 + #937 — admin embeddings surface.
 *
 *   GET  /api/admin/embeddings                                  → active backend capabilities + health + registered descriptors
 *   GET  /api/admin/embeddings/projects/:projectId/coverage     → per-project embedding-model coverage
 *   POST /api/admin/embeddings/projects/:projectId/reindex      → re-embed + rebuild a project's vector table (async)
 *
 * GETs require `admin.read`; the reindex POST requires `admin.write`. The
 * embeddings backend is pluggable (registry-driven) so this surface never
 * hardcodes a single provider — it reflects whatever backend the deployment
 * configured via `EMBED_BACKEND` / `AI_OFFLINE`.
 *
 * Epic #406 (#423) — the reindex POST no longer blocks the request thread while
 * the whole corpus is re-embedded (which froze the UI and risked a gateway/idle
 * timeout for large projects). It now enqueues a fire-and-forget background job
 * and returns `202 { jobId }` promptly. The background worker streams progress
 * over the unified `job:lifecycle` bus under the `embeddings-reindex` JobKind:
 * `started` → `progress` (0-100, from the existing `reindexProject` `onProgress`
 * callback) → `completed` / `failed`. Failures broadcast a generic, user-safe
 * message (#254) — raw error detail stays in the server log only.
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { AppError } from "../../middleware/error-handler.js";
import { requireAuth } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/require-permission.js";
import { getEmbedder, listBackendDescriptors } from "../../lib/rag/embedder.js";
import { getKnowledgeService, ReindexConflictError } from "../../lib/rag/knowledge-service.js";
import {
  defaultMigrationDeps,
  migrationStatus,
  planMigration,
} from "../../lib/rag/embed-migration.js";
import { jobEvents, genericFailureMessage } from "../../lib/socket/job-events.js";
import { createChildLogger } from "../../lib/logger.js";

const log = createChildLogger("admin:embeddings");

// Project ids are cuids in this codebase; keep the guard permissive but reject
// path-traversal / SQL-hostile shapes mirrored from the vector store.
const projectIdSchema = z
  .string()
  .min(1, "projectId is required")
  .max(128)
  .refine((v) => !/[\\/\s\0]|\.\./.test(v), "invalid projectId");

const reindexBodySchema = z
  .object({
    batchSize: z.coerce.number().int().min(1).max(1000).optional(),
    /**
     * Issue #787 — discard a surviving shadow and re-embed from scratch. Default
     * false: an interrupted reindex RESUMES from its checkpoint.
     */
    fresh: z.coerce.boolean().optional(),
  })
  .optional();

function ok<T>(data: T): { success: true; data: T } {
  return { success: true, data };
}

function parseProjectId(raw: string): string {
  const parsed = projectIdSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError(400, "INVALID_PROJECT_ID", "Invalid projectId", {
      issues: parsed.error.flatten(),
    });
  }
  return parsed.data;
}

/**
 * Background reindex worker (Epic #406 / #423). Runs OUTSIDE the HTTP request so
 * a large-corpus re-embed never holds the connection open. Streams lifecycle
 * progress on the `embeddings-reindex` JobKind keyed by `jobId`, scoped to the
 * `project:{projectId}` room. Exported for direct unit testing without a socket.
 *
 * Always resolves — every failure path (including a {@link ReindexConflictError}
 * from a concurrent reindex) is caught and surfaced as a `failed` lifecycle
 * event with a generic, user-safe message (#254). The full error is logged
 * server-side only and never reaches the client over the socket.
 */
export async function runReindexJob(
  jobId: string,
  projectId: string,
  opts: { batchSize?: number; fresh?: boolean } = {},
): Promise<void> {
  jobEvents.started("embeddings-reindex", jobId, projectId, "Reindexing embeddings");
  try {
    const result = await getKnowledgeService().reindexProject(projectId, {
      ...(opts.batchSize !== undefined ? { batchSize: opts.batchSize } : {}),
      ...(opts.fresh !== undefined ? { fresh: opts.fresh } : {}),
      onProgress: ({ processed, total }) => {
        const pct =
          total > 0 ? Math.min(100, Math.max(0, Math.round((processed / total) * 100))) : 0;
        jobEvents.progress(
          "embeddings-reindex",
          jobId,
          projectId,
          pct,
          `Re-embedded ${processed}/${total} chunks`,
        );
      },
    });
    // #787 — say so when the run RESUMED. An operator watching a restarted job
    // otherwise sees "reindexed 15,000 chunks" after four minutes of wall-clock
    // and reasonably concludes something is wrong.
    const resumed =
      result.resumedChunks > 0
        ? ` (${result.resumedChunks} resumed from an interrupted run, ${result.embeddedChunks} re-embedded)`
        : "";
    jobEvents.completed(
      "embeddings-reindex",
      jobId,
      projectId,
      `Reindexed ${result.reindexedChunks} of ${result.totalChunks} chunks to ${result.currentModel} (${result.currentDimension}d)${resumed}.`,
    );
  } catch (err) {
    // ReindexConflictError and any other failure surface the SAME generic,
    // user-safe message over the socket; raw detail stays in the server log.
    const detail =
      err instanceof ReindexConflictError ? `${err.code}: ${err.message}` : String(err);
    log.error("Embeddings reindex failed", { projectId, jobId, error: detail });
    jobEvents.failed(
      "embeddings-reindex",
      jobId,
      projectId,
      genericFailureMessage("embeddings-reindex"),
    );
  }
}

export function embeddingsAdminRouter(): Router {
  const r = Router();

  // GET /  → active backend + health + the full registry.
  r.get(
    "/",
    requireAuth,
    requirePermission("admin.read"),
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        const embedder = getEmbedder();
        const health = await embedder.health();
        // #783 — the capabilities are read AFTER health(), because health() is
        // what warms the backend, and a warm that fell back to the hash stub
        // CHANGES them (model, dimension, key). Reading them first reported the
        // model the deployment *configured* while the process embedded with
        // another one — the panel's own version of the silent fallback.
        const capabilities = embedder.capabilities();
        res.json(
          ok({
            active: {
              ...capabilities,
              // `healthy` is false for an active hash fallback: it is serving, but
              // what it serves is not semantic. The panel must not show a green
              // tick over an index filling with noise.
              healthy: health.ok,
              status: health.status,
              fellBack: health.fellBack,
              hashFallbackAllowed: health.hashFallbackAllowed,
              error: health.error ?? null,
            },
            backends: listBackendDescriptors(),
          }),
        );
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /coverage  → DEPLOYMENT-WIDE per-model coverage (issue #787).
  //
  // The existing per-project report answers "does THIS project need a reindex",
  // which presupposes the operator already knows which projects to ask about.
  // Mid-migration the question runs the other way — which projects are still on
  // the old generation? — and that is what this answers, in one groupBy, together
  // with the pgvector column width that gates the whole migration.
  //
  // Data-only: it feeds the existing Admin → Embedding backends panel's data
  // source. No new UI element (and therefore no new e2e surface).
  r.get(
    "/coverage",
    requireAuth,
    requirePermission("admin.read"),
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        const status = await migrationStatus(defaultMigrationDeps());
        const plan = planMigration(status);
        res.json(
          ok({
            ...status.coverage,
            store: status.store,
            embedder: {
              model: status.embedder.model,
              dimension: status.embedder.dimension,
              backend: status.embedder.backend,
              status: status.embedder.status,
              fellBack: status.embedder.fellBack,
            },
            migration: {
              upToDate: plan.upToDate,
              blocked: plan.blocked,
              needsColumnMigration: plan.needsColumnMigration,
              projectsToReindex: plan.projectsToReindex,
              steps: plan.steps,
            },
          }),
        );
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /projects/:projectId/coverage  → per-project model coverage + shadow state.
  r.get(
    "/projects/:projectId/coverage",
    requireAuth,
    requirePermission("admin.read"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const projectId = parseProjectId(String(req.params.projectId));
        const svc = getKnowledgeService();
        const [report, shadow] = await Promise.all([
          svc.coverageReport(projectId),
          // #787 — additive. A project with a resumable shadow looks identical to
          // one that was never reindexed if you only look at coverage.
          svc.reindexShadowState(projectId),
        ]);
        res.json(ok({ ...report, shadow }));
      } catch (err) {
        next(err);
      }
    },
  );

  // DELETE /projects/:projectId/reindex  → discard the resume checkpoint (#787).
  // Never touches the live index — the worst it can cost is a re-embed.
  r.delete(
    "/projects/:projectId/reindex",
    requireAuth,
    requirePermission("admin.write"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const projectId = parseProjectId(String(req.params.projectId));
        await getKnowledgeService().discardReindexShadow(projectId);
        res.json(ok({ projectId, discarded: true }));
      } catch (err) {
        if (err instanceof ReindexConflictError) {
          next(
            new AppError(409, err.code, "A reindex is already in progress for this project", {
              projectId: err.projectId,
            }),
          );
          return;
        }
        next(err);
      }
    },
  );

  // POST /projects/:projectId/reindex  → enqueue an async reindex (Epic #406 /
  // #423). Returns 202 with a jobId promptly; progress streams over the
  // `job:lifecycle` bus under the `embeddings-reindex` kind, scoped to
  // `project:{projectId}`. The previous version awaited the full re-embed
  // inline, freezing the UI and risking a gateway timeout for large corpora.
  r.post(
    "/projects/:projectId/reindex",
    requireAuth,
    requirePermission("admin.write"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const projectId = parseProjectId(String(req.params.projectId));
        const body = reindexBodySchema.safeParse(req.body);
        if (!body.success) {
          throw new AppError(400, "INVALID_BODY", "Invalid request body", {
            issues: body.error.flatten(),
          });
        }
        const jobId = randomUUID();
        // Fire-and-forget: the worker owns all lifecycle emission + error
        // handling and always resolves, so this never rejects into the request.
        void runReindexJob(jobId, projectId, {
          ...(body.data?.batchSize !== undefined ? { batchSize: body.data.batchSize } : {}),
          ...(body.data?.fresh !== undefined ? { fresh: body.data.fresh } : {}),
        });
        res.status(202).json(ok({ jobId, projectId, status: "started" }));
      } catch (err) {
        next(err);
      }
    },
  );

  return r;
}
