/**
 * Epic #803 (Epic 09) — Domain Eval read API (file-backed).
 *
 *   GET /api/eval/domain/runs?days=30     (auth) — run summaries for the trend
 *   GET /api/eval/domain/runs/:id         (auth) — full run incl per-item diff
 *
 * Data comes from the committed `eval-results/<runId>.json` envelopes, not a
 * database — so the nightly CI commit is all that's needed for the UI to update.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { type ApiResponse, toDomainRunSummary } from "@metis/shared";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { AppError } from "../middleware/error-handler.js";
import { defaultResultsDir, loadAllRuns, readRun } from "../lib/eval/domain/results-store.js";

function ok<T>(data: T): ApiResponse<T> {
  return { success: true, data };
}

const listSchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(90),
});

export interface DomainEvalRouterDeps {
  /** Override the results directory (test seam). Defaults to `<cwd>/eval-results`. */
  resultsDir?: string;
}

export function domainEvalRouter(deps: DomainEvalRouterDeps = {}): Router {
  const r = Router();
  const resultsDir = deps.resultsDir ?? defaultResultsDir();

  // SECURITY (OWASP A01 — epic #671, #678): regression-suite run history is
  // internal platform data with no tenant/project PK to scope on, so a plain
  // permission gate is the correct control. `admin.read` is the catalog's
  // internal/admin read scope (redacted runtime config today); reuse it here.
  r.get(
    "/runs",
    requireAuth,
    requirePermission("admin.read"),
    async (req: Request, res: Response) => {
      const parsed = listSchema.safeParse(req.query);
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid query", {
          issues: parsed.error.flatten(),
        });
      }
      const { days } = parsed.data;
      const since = Date.now() - days * 86_400_000;
      const runs = await loadAllRuns(resultsDir);
      const summaries = runs
        .filter((run) => new Date(run.startedAt).getTime() >= since)
        .map(toDomainRunSummary);
      res.json(ok({ runs: summaries }));
    },
  );

  r.get(
    "/runs/:id",
    requireAuth,
    requirePermission("admin.read"),
    async (req: Request, res: Response) => {
      const id = String(req.params.id ?? "");
      if (!id) throw new AppError(400, "VALIDATION_ERROR", "id required");
      const run = await readRun(resultsDir, id);
      if (!run)
        throw new AppError(404, "DOMAIN_EVAL_RUN_NOT_FOUND", `Domain eval run ${id} not found`);
      res.json(ok({ run }));
    },
  );

  return r;
}
