/**
 * Epic #394 P2 (#404) — PR-review history read API for the UI.
 *
 * Mounted at `/api/projects/:projectId/pr-reviews` (LIST) and
 * `/api/projects/:projectId/pr-reviews/:prNumber` (DETAIL).
 *
 * Both endpoints are gated on the existing `pr.review.read` permission
 * so the same RBAC rule that protects `/api/run-reviews/:runId` covers
 * the list view too. The detail endpoint returns the persisted
 * `PrReviewState` row plus a deep-link to the AgentRun the review was
 * recorded under (so the UI can pivot to `/runs/[runId]/review`).
 */
import { Router, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import type { ApiResponse } from "@metis/shared";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { AppError } from "../middleware/error-handler.js";
import {
  getPrReviewState,
  listPrReviewStatesForProject,
  type PrReviewStateRow,
} from "../lib/agents/pr-reviewer/state-repo.js";
import { getPrReviewWorker } from "../lib/agents/pr-reviewer/worker-singleton.js";
import type { PrReviewQueue } from "../lib/agents/pr-reviewer/queue.js";

function ok<T>(data: T): ApiResponse<T> {
  return { success: true, data };
}

interface PrReviewStateView {
  id: string;
  projectId: string;
  repoOwner: string;
  repoName: string;
  prNumber: number;
  prUrl: string;
  lastReviewedSha: string | null;
  lastVerdict: string | null;
  lastRunId: string | null;
  acVerdicts: PrReviewStateRow["acVerdicts"];
  acPassRate: number;
  updatedAt: string;
  createdAt: string;
}

function toView(row: PrReviewStateRow): PrReviewStateView {
  const total = row.acVerdicts.length;
  const satisfied = row.acVerdicts.filter((v) => v.verdict === "satisfied").length;
  return {
    id: row.id,
    projectId: row.projectId,
    repoOwner: row.repoOwner,
    repoName: row.repoName,
    prNumber: row.prNumber,
    prUrl: `https://github.com/${row.repoOwner}/${row.repoName}/pull/${row.prNumber}`,
    lastReviewedSha: row.lastReviewedSha,
    lastVerdict: row.lastVerdict,
    lastRunId: row.lastRunId,
    acVerdicts: row.acVerdicts,
    acPassRate: total === 0 ? 0 : satisfied / total,
    updatedAt: row.updatedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

function parseIntSafe(value: unknown, fallback: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(Math.floor(n), max);
}

export interface PrReviewsRouterDeps {
  /**
   * Test seam — bypass the singleton lookup and return a queue directly.
   * In production the queue is owned by the worker started in
   * `server.ts` and reached via `getPrReviewWorker()`.
   */
  resolveQueue?: () => PrReviewQueue | null;
}

export function prReviewsRouter(deps: PrReviewsRouterDeps = {}): Router {
  const r = Router({ mergeParams: true });
  const resolveQueue = deps.resolveQueue ?? (() => getPrReviewWorker()?.queue ?? null);

  r.get(
    "/",
    requireAuth,
    requirePermission("pr.review.read"),
    async (req: Request, res: Response) => {
      const projectId = String((req.params as { projectId?: string }).projectId ?? "");
      if (!projectId) throw new AppError(400, "MISSING_PROJECT_ID", "projectId is required");
      const limit = parseIntSafe(req.query.limit, 50, 200);
      const offset = parseIntSafe(req.query.offset, 0, 10_000);
      const out = await listPrReviewStatesForProject(projectId, { limit, offset });
      res.json(ok({ items: out.items.map(toView), total: out.total, limit, offset }));
    },
  );

  r.get(
    "/:prNumber",
    requireAuth,
    requirePermission("pr.review.read"),
    async (req: Request, res: Response) => {
      const projectId = String((req.params as { projectId?: string }).projectId ?? "");
      const prNumberRaw = (req.params as { prNumber?: string }).prNumber;
      const prNumber = Number(prNumberRaw);
      if (!projectId || !Number.isFinite(prNumber) || prNumber <= 0) {
        throw new AppError(400, "BAD_REQUEST", "projectId and prNumber are required");
      }
      // The UI passes the (owner, repo) via querystring since a project may
      // be wired to multiple repos in the future. Required so the unique
      // index is fully specified.
      const repoOwner = String(req.query.owner ?? "");
      const repoName = String(req.query.repo ?? "");
      if (!repoOwner || !repoName) {
        throw new AppError(400, "BAD_REQUEST", "owner and repo query params are required");
      }
      const row = await getPrReviewState({
        projectId,
        repoOwner,
        repoName,
        prNumber: Math.floor(prNumber),
      });
      if (!row) {
        res.status(404).json({ success: false, error: "REVIEW_NOT_FOUND" });
        return;
      }
      res.json(ok(toView(row)));
    },
  );

  /**
   * Epic #394 P2 review #404 — Re-run a previously-recorded PR review.
   *
   * Manually re-enqueues the PR onto the same async worker that the
   * webhook uses, so an operator can force a fresh judgement without
   * waiting for the next `synchronize` event. Gated behind
   * `pr.review.manage` (NOT the broader `pr.review.read`) so read-only
   * users see a clear 403 from `requirePermission` rather than an
   * accidental requeue.
   */
  r.post(
    "/:prNumber/re-review",
    requireAuth,
    requirePermission("pr.review.manage"),
    async (req: Request, res: Response) => {
      const projectId = String((req.params as { projectId?: string }).projectId ?? "");
      const prNumberRaw = (req.params as { prNumber?: string }).prNumber;
      const prNumber = Number(prNumberRaw);
      if (!projectId || !Number.isFinite(prNumber) || prNumber <= 0) {
        throw new AppError(400, "BAD_REQUEST", "projectId and prNumber are required");
      }
      const repoOwner = String(req.body?.owner ?? req.query.owner ?? "");
      const repoName = String(req.body?.repo ?? req.query.repo ?? "");
      if (!repoOwner || !repoName) {
        throw new AppError(400, "BAD_REQUEST", "owner and repo are required");
      }
      const row = await getPrReviewState({
        projectId,
        repoOwner,
        repoName,
        prNumber: Math.floor(prNumber),
      });
      if (!row) {
        res.status(404).json({ success: false, error: "REVIEW_NOT_FOUND" });
        return;
      }
      const queue = resolveQueue();
      if (!queue) {
        // The worker is always started in production by server.ts; a
        // missing queue here means an operator hit this endpoint before
        // boot finished or with the worker explicitly disabled. Return
        // 503 so the UI can show a clear "try again" message instead of
        // a confusing 500.
        res.status(503).json({ success: false, error: "WORKER_UNAVAILABLE" });
        return;
      }
      const enqueueOut = queue.enqueue({
        // No GitHub `X-Delivery` header on a manual re-run — the dedup
        // table is keyed off this id so we use a synthesised one that
        // includes the PR + timestamp + a short random suffix to stay
        // unique even on sub-millisecond double-clicks (post-`e7eb006`
        // re-review nit: timestamp alone collides under fast retries).
        deliveryId: `manual-rerun-${row.repoOwner}-${row.repoName}-${row.prNumber}-${Date.now()}-${randomUUID().slice(0, 8)}`,
        projectId: row.projectId,
        owner: row.repoOwner,
        repo: row.repoName,
        prNumber: row.prNumber,
        context: {
          action: "manual_rerun",
          headSha: row.lastReviewedSha,
          actorUserId: (req as Request & { user?: { userId?: string } }).user?.userId ?? null,
        },
      });
      res.status(202).json(
        ok({
          jobId: enqueueOut.jobId,
          queueDepth: enqueueOut.queueDepth,
          prNumber: row.prNumber,
        }),
      );
    },
  );

  return r;
}
