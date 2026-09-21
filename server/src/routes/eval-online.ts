/**
 * Epic #1316 / issue #1321 — online (live-traffic) eval read API.
 *
 *   GET /api/eval/online/status              (auth) — operator status + budget
 *   GET /api/eval/online/windows?days=30     (auth) — window summaries for the trend
 *   GET /api/eval/online/windows/:id         (auth) — one window incl. per-sample rows
 *
 * File-backed, like the domain-eval read API: data comes from the
 * `eval-results/online/<windowId>.json` envelopes the scorer writes. Those
 * envelopes are content-free by construction (see `eval/online/store.ts`), so
 * this endpoint cannot leak user content even though it serves per-sample rows.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { type ApiResponse, toOnlineWindowSummary } from "@metis/shared";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { AppError } from "../middleware/error-handler.js";
import { resolveOnlineEvalConfig } from "../lib/eval/online/config.js";
import { loadAllWindows, readWindow } from "../lib/eval/online/store.js";
import { getOnlineEvalScorer, type OnlineEvalScorer } from "../lib/eval/online/scorer.js";

function ok<T>(data: T): ApiResponse<T> {
  return { success: true, data };
}

const listSchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(90),
});

export interface OnlineEvalRouterDeps {
  /** Override the results directory (test seam). Defaults to the resolved config. */
  resultsDir?: string;
  /** Override the scorer (test seam). */
  scorer?: OnlineEvalScorer;
}

export function onlineEvalRouter(deps: OnlineEvalRouterDeps = {}): Router {
  const r = Router();
  const dirFor = () => deps.resultsDir ?? resolveOnlineEvalConfig().resultsDir;
  const scorerFor = () => deps.scorer ?? getOnlineEvalScorer();

  // SECURITY (OWASP A01): online-eval windows are internal platform telemetry
  // with no tenant/project PK to scope on, so a permission gate is the correct
  // control — same posture and same scope as the domain-eval read API (#678).
  r.get("/status", requireAuth, requirePermission("admin.read"), async (_req, res: Response) => {
    res.json(ok({ status: await scorerFor().status() }));
  });

  r.get(
    "/windows",
    requireAuth,
    requirePermission("admin.read"),
    async (req: Request, res: Response) => {
      const parsed = listSchema.safeParse(req.query);
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid query", {
          issues: parsed.error.flatten(),
        });
      }
      const since = Date.now() - parsed.data.days * 86_400_000;
      const windows = await loadAllWindows(dirFor());
      const summaries = windows
        .filter((w) => new Date(w.completedAt).getTime() >= since)
        .map(toOnlineWindowSummary);
      res.json(ok({ windows: summaries }));
    },
  );

  r.get(
    "/windows/:id",
    requireAuth,
    requirePermission("admin.read"),
    async (req: Request, res: Response) => {
      const id = String(req.params.id ?? "");
      if (!id) throw new AppError(400, "VALIDATION_ERROR", "id required");
      const window = await readWindow(dirFor(), id);
      if (!window) {
        throw new AppError(
          404,
          "ONLINE_EVAL_WINDOW_NOT_FOUND",
          `Online eval window ${id} not found`,
        );
      }
      res.json(ok({ window }));
    },
  );

  return r;
}
