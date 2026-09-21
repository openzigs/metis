/**
 * Epic #594 / Issue #607 — Usage API routes.
 *
 * Endpoints:
 *   GET /api/projects/:projectId/usage      — project usage (range, groupBy)
 *   GET /api/projects/:projectId/usage/csv   — export CSV
 *   GET /api/projects/:projectId/token-budget — get project budget
 *   PUT /api/projects/:projectId/token-budget — set project budget
 *   GET /api/admin/usage                     — admin usage (range, groupBy)
 *   GET /api/admin/usage/csv                 — admin CSV export
 *   GET /api/admin/token-budgets/:userId     — get user budget
 *   PUT /api/admin/token-budgets/:userId     — set user budget
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { ApiResponse } from "@metis/shared";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { requireRole } from "../middleware/require-role.js";
import { AppError } from "../middleware/error-handler.js";
import { getUsageService } from "../lib/usage/usage-service.js";
import { getTokenBudgetController } from "../lib/ai/token-budget-controller.js";

function ok<T>(data: T): ApiResponse<T> {
  return { success: true, data };
}

const rangeSchema = z.enum(["7d", "30d", "90d"]).default("7d");
const groupBySchema = z.enum(["day", "model", "user", "project", "agentStep"]).default("day");

const budgetSchema = z.object({
  dailyTokenLimit: z.number().int().positive().nullable().optional(),
  monthlyTokenLimit: z.number().int().positive().nullable().optional(),
  downgradeModel: z.string().max(200).nullable().optional(),
});

export function projectUsageRouter(): Router {
  const r = Router({ mergeParams: true });

  r.get(
    "/",
    requireAuth,
    requirePermission("project.read"),
    async (req: Request, res: Response) => {
      const projectId = String(req.params.projectId);
      const range = rangeSchema.parse(req.query.range ?? "7d");
      const groupBy = groupBySchema.parse(req.query.groupBy ?? "day");
      const svc = getUsageService();
      const usage = await svc.projectUsage(projectId, { range, groupBy });
      res.json(ok(usage));
    },
  );

  r.get(
    "/csv",
    requireAuth,
    requirePermission("project.read"),
    async (req: Request, res: Response) => {
      const projectId = String(req.params.projectId);
      const range = rangeSchema.parse(req.query.range ?? "7d");
      const groupBy = groupBySchema.parse(req.query.groupBy ?? "day");
      const svc = getUsageService();
      const usage = await svc.projectUsage(projectId, { range, groupBy });
      res.setHeader("Content-Type", "text/csv");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="usage-${projectId}-${range}.csv"`,
      );
      res.send(svc.toCSV(usage.rows));
    },
  );

  return r;
}

export function projectTokenBudgetRouter(): Router {
  const r = Router({ mergeParams: true });
  const ctrl = getTokenBudgetController();

  r.get(
    "/",
    requireAuth,
    requirePermission("project.read"),
    async (req: Request, res: Response) => {
      const projectId = String(req.params.projectId);
      const budget = await ctrl.getProjectBudget(projectId);
      const check = await ctrl.check(projectId);
      res.json(ok({ budget, status: check }));
    },
  );

  r.put(
    "/",
    requireAuth,
    requirePermission("project.update"),
    async (req: Request, res: Response) => {
      const projectId = String(req.params.projectId);
      const parsed = budgetSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(
          400,
          "VALIDATION_ERROR",
          parsed.error.issues[0]?.message ?? "Invalid input",
        );
      }
      const budget = await ctrl.setProjectBudget(projectId, parsed.data);
      res.json(ok({ budget }));
    },
  );

  return r;
}

export function adminUsageRouter(): Router {
  const r = Router();

  r.get("/", requireAuth, requireRole("admin"), async (req: Request, res: Response) => {
    const range = rangeSchema.parse(req.query.range ?? "30d");
    const groupBy = groupBySchema.parse(req.query.groupBy ?? "project");
    const userId = typeof req.query.userId === "string" ? req.query.userId : undefined;
    const svc = getUsageService();
    const usage = await svc.adminUsage({ range, groupBy, userId });
    res.json(ok(usage));
  });

  r.get("/csv", requireAuth, requireRole("admin"), async (req: Request, res: Response) => {
    const range = rangeSchema.parse(req.query.range ?? "30d");
    const groupBy = groupBySchema.parse(req.query.groupBy ?? "project");
    const svc = getUsageService();
    const usage = await svc.adminUsage({ range, groupBy });
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="admin-usage-${range}.csv"`);
    res.send(svc.toCSV(usage.rows));
  });

  return r;
}

export function adminTokenBudgetRouter(): Router {
  const r = Router();
  const ctrl = getTokenBudgetController();

  r.get("/:userId", requireAuth, requireRole("admin"), async (req: Request, res: Response) => {
    const userId = String(req.params.userId);
    const budgets = await ctrl.getUserBudgets(userId);
    const check = await ctrl.check(undefined, userId);
    res.json(ok({ budgets, status: check }));
  });

  r.put("/:userId", requireAuth, requireRole("admin"), async (req: Request, res: Response) => {
    const userId = String(req.params.userId);
    const parsed = budgetSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        parsed.error.issues[0]?.message ?? "Invalid input",
      );
    }
    const budget = await ctrl.setUserBudget(userId, parsed.data);
    res.json(ok({ budget }));
  });

  return r;
}
