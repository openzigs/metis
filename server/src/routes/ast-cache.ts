/**
 * Epic #596 / Issue #616 — AST Summary Cache rebuild endpoint.
 *
 * POST /api/projects/:projectId/repositories/:repoId/rebuild-cache
 *
 * Triggers a rebuild of the AST summary cache for a repository's source files.
 * Reads the repository from the connector's clone directory and re-indexes
 * every supported source file, returning real rebuild statistics (indexed
 * files, skipped, total symbols).
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import type { ApiResponse } from "@metis/shared";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { AppError } from "../middleware/error-handler.js";
import { getASTSummaryCache, rebuildCacheFromCloneDir } from "../lib/analysis/ast-summary-cache.js";
import { pullOrCloneRepo } from "../lib/connectors/repo/repo-service.js";
import { prisma } from "../lib/prisma.js";

function ok<T>(data: T): ApiResponse<T> {
  return { success: true, data };
}

export function astCacheRouter(): Router {
  const r = Router({ mergeParams: true });

  r.post(
    "/rebuild-cache",
    requireAuth,
    requirePermission("analysis.run"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const projectId = String(req.params.projectId);
        const repoId = String(req.params.repoId);
        const actorId = req.user?.userId;
        if (!actorId) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");

        // Verify project + repo connection exists
        const repo = await prisma.repoConnection.findFirst({
          where: {
            id: repoId,
            projectId,
            deletedAt: null,
          },
        });

        if (!repo) {
          res
            .status(404)
            .json({
              success: false,
              error: { code: "NOT_FOUND", message: "Repository not found" },
            });
          return;
        }

        // Pull (or clone) the repo into the connector's clone dir, then rebuild
        // the AST summary cache from the on-disk source files.
        const cache = getASTSummaryCache();
        const { path: cloneDir } = await pullOrCloneRepo(projectId, repoId, actorId);
        const result = await rebuildCacheFromCloneDir(cache, cloneDir);

        res.json(
          ok({
            repoId,
            projectId,
            message: "Cache rebuild complete",
            stats: {
              indexedFiles: result.indexed,
              skippedFiles: result.skipped,
              totalSymbols: result.totalSymbols,
              discoveredFiles: result.discovered,
            },
          }),
        );
      } catch (err) {
        next(err);
      }
    },
  );

  return r;
}
