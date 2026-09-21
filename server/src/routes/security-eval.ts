/**
 * Epic #157 — Security Eval (issue #152).
 *
 *   POST /api/security-eval/run
 *
 * Loads the curated red-team fixtures, runs the default defense, and returns
 * a JSON `RedTeamReport`. Updates `Project.redTeamLastRunAt` +
 * `Project.redTeamLastScore` when a `projectId` is provided so the dashboard
 * surfaces the most-recent run.
 */
import path from "node:path";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { type ApiResponse } from "@metis/shared";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { AppError } from "../middleware/error-handler.js";
import { audit } from "../lib/audit/audit-service.js";
import { prisma } from "../lib/prisma.js";
import { loadFixtures, runRedTeam } from "../lib/rag/red-team-harness.js";

function ok<T>(data: T): ApiResponse<T> {
  return { success: true, data };
}

const runSchema = z.object({
  projectId: z.string().min(1).optional(),
});

export interface SecurityEvalRouterDeps {
  /** Override the fixture root for tests. */
  fixtureRoot?: string;
}

export function securityEvalRouter(deps: SecurityEvalRouterDeps = {}): Router {
  const r = Router();
  const fixtureRoot = deps.fixtureRoot ?? path.resolve(process.cwd(), "eval", "red-team");

  r.post(
    "/run",
    requireAuth,
    requirePermission("admin.write"),
    async (req: Request, res: Response) => {
      const parsed = runSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid payload", {
          issues: parsed.error.flatten(),
        });
      }
      const actor = req.user!;
      const fixtures = await loadFixtures(fixtureRoot);
      const report = runRedTeam({ fixtures });
      if (parsed.data.projectId) {
        await prisma.project.updateMany({
          where: { id: parsed.data.projectId, deletedAt: null },
          data: {
            redTeamLastRunAt: new Date(),
            redTeamLastScore: report.score,
          },
        });
      }
      audit({
        actor: { id: actor.userId },
        action: "security-eval.run",
        target: parsed.data.projectId
          ? { type: "project", id: parsed.data.projectId }
          : { type: "system", id: "security-eval" },
        metadata: {
          total: report.total,
          passed: report.passed,
          failed: report.failed,
          score: report.score,
        },
      });
      res.json(ok(report));
    },
  );

  return r;
}
