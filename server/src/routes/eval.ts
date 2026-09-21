/**
 * Epic #194 (C.5) — Nightly leaderboard endpoint.
 *
 *   GET  /api/eval/leaderboard?bench=swe-bench-pro|tau-bench   (auth)
 *   GET  /api/eval/leaderboard/runs/:id                        (auth)
 *   POST /api/eval/leaderboard/run                             (admin.write)
 *
 * Read endpoints expose the latest 30 days of BenchRun results so the
 * OPERATIONS dashboard widget can render the trend lines. Admins see the
 * full per-task detail; non-admins get the run-level rollup only (RBAC AC).
 *
 * The trigger endpoint kicks off a manual benchmark run — useful for
 * smoke-testing after a config change. The actual runner work happens
 * asynchronously via the injected `triggerRunner`.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { type ApiResponse } from "@metis/shared";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { AppError } from "../middleware/error-handler.js";
import { prisma } from "../lib/prisma.js";

function ok<T>(data: T): ApiResponse<T> {
  return { success: true, data };
}

const SUPPORTED_BENCHES = ["swe-bench-pro", "tau-bench"] as const;
type Bench = (typeof SUPPORTED_BENCHES)[number];

const listSchema = z.object({
  bench: z.enum(SUPPORTED_BENCHES).optional(),
  days: z.coerce.number().int().min(1).max(365).default(30),
});

const triggerSchema = z.object({
  bench: z.enum(SUPPORTED_BENCHES),
  model: z.string().min(1).max(120).default("offline-stub"),
  costCapCents: z.number().int().min(0).max(10_000_000).optional(),
});

export type TriggerRunner = (input: {
  bench: Bench;
  model: string;
  costCapCents?: number;
}) => Promise<{ benchRunId: string; status: string }>;

export interface EvalRouterDeps {
  /** Test seam — override the trigger so we don't import the heavy runner. */
  triggerRunner?: TriggerRunner;
  /**
   * Override the env check that decides whether the manual trigger is a
   * no-op (returns `disabled` without spinning up a runner).
   */
  isEnabled?: () => boolean;
}

export function isEvalEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.EVAL_NIGHTLY_ENABLED ?? "").toLowerCase() === "true";
}

export function evalRouter(deps: EvalRouterDeps = {}): Router {
  const r = Router();

  r.get("/leaderboard", requireAuth, async (req: Request, res: Response) => {
    const parsed = listSchema.safeParse(req.query);
    if (!parsed.success) {
      throw new AppError(400, "VALIDATION_ERROR", "Invalid query", {
        issues: parsed.error.flatten(),
      });
    }
    const { bench, days } = parsed.data;
    const since = new Date(Date.now() - days * 86_400_000);
    const where: { benchmark?: Bench; startedAt: { gte: Date } } = { startedAt: { gte: since } };
    if (bench) where.benchmark = bench;
    const runs = await prisma.benchRun.findMany({
      where,
      orderBy: { startedAt: "desc" },
      take: 200,
    });
    res.json(
      ok({
        runs: runs.map((run) => ({
          id: run.id,
          benchmark: run.benchmark,
          model: run.model,
          score: run.score,
          totalTasks: run.totalTasks,
          passedTasks: run.passedTasks,
          meanTokens: run.meanTokens,
          meanCostCents: run.meanCostCents,
          meanLatencyMs: run.meanLatencyMs,
          startedAt: run.startedAt.toISOString(),
          completedAt: run.completedAt?.toISOString() ?? null,
          status: run.status,
        })),
      }),
    );
  });

  r.get("/leaderboard/runs/:id", requireAuth, async (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    if (!id) throw new AppError(400, "VALIDATION_ERROR", "id required");
    const run = await prisma.benchRun.findUnique({
      where: { id },
      include: { tasks: { orderBy: { taskId: "asc" } } },
    });
    if (!run) throw new AppError(404, "BENCH_RUN_NOT_FOUND", `BenchRun ${id} not found`);
    const isAdmin = req.user?.role === "admin";
    res.json(
      ok({
        run: {
          id: run.id,
          benchmark: run.benchmark,
          model: run.model,
          score: run.score,
          totalTasks: run.totalTasks,
          passedTasks: run.passedTasks,
          meanTokens: run.meanTokens,
          meanCostCents: run.meanCostCents,
          meanLatencyMs: run.meanLatencyMs,
          startedAt: run.startedAt.toISOString(),
          completedAt: run.completedAt?.toISOString() ?? null,
          status: run.status,
          metadata: safeParse(run.metadata),
        },
        tasks: run.tasks.map((t) => ({
          id: t.id,
          taskId: t.taskId,
          passed: t.passed,
          score: t.score,
          tokens: t.tokens,
          costCents: t.costCents,
          latencyMs: t.latencyMs,
          // RBAC: only admins see the diff content (may include source code).
          expected: isAdmin ? t.expected : null,
          actual: isAdmin ? t.actual : null,
          error: t.error,
        })),
      }),
    );
  });

  r.post(
    "/leaderboard/run",
    requireAuth,
    requirePermission("admin.write"),
    async (req: Request, res: Response) => {
      const parsed = triggerSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid payload", {
          issues: parsed.error.flatten(),
        });
      }
      const enabled = (deps.isEnabled ?? isEvalEnabled)();
      if (!enabled) {
        res
          .status(202)
          .json(
            ok({
              benchRunId: null,
              status: "disabled",
              reason: "EVAL_NIGHTLY_ENABLED is not 'true'",
            }),
          );
        return;
      }
      if (!deps.triggerRunner) {
        throw new AppError(503, "EVAL_RUNNER_UNAVAILABLE", "Runner not wired in this server build");
      }
      const result = await deps.triggerRunner(parsed.data);
      res.status(202).json(ok(result));
    },
  );

  return r;
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
