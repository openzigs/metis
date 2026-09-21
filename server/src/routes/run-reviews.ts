/**
 * Epic #192 (A.4 + A.6) + Epic #394 (#400, #401) — manual PR-review trigger + reads.
 *
 * Mounted at `/api/run-reviews`. Two routes:
 *   - `POST /` — manually run the PR-reviewer agent against a PR. Requires
 *     `pr.review` permission. Body: `{ projectId, prNumber, prTitle,
 *     prBody, diff, criteria, owner, repo }`. The judge LLM and Octokit
 *     client are looked up at request time (test injection happens via the
 *     factory deps). Returns HTTP 429 when the project's monthly PR-review
 *     budget is exhausted.
 *   - `GET /:runId` — read the persisted PR-review record (the agent stores
 *     its result as a `pr_review` step on the AgentRun). Requires
 *     `pr.review.read`.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { ApiResponse } from "@metis/shared";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { AppError } from "../middleware/error-handler.js";
import { prisma } from "../lib/prisma.js";
import {
  defaultBudgetDeps,
  runPrReview,
  type JudgeLike,
  type RunPrReviewDeps,
} from "../lib/agents/pr-reviewer/agent.js";
import type { OctokitLike } from "../lib/agents/pr-reviewer/github-review-poster.js";
import { recordStep, startRun, finishRun } from "../lib/replay/runs-service.js";

function ok<T>(data: T): ApiResponse<T> {
  return { success: true, data };
}

const triggerSchema = z.object({
  projectId: z.string().min(1),
  owner: z.string().min(1),
  repo: z.string().min(1),
  prNumber: z.number().int().positive(),
  prTitle: z.string().default(""),
  prBody: z.string().default(""),
  diff: z.string().default(""),
  criteria: z.array(z.object({ id: z.string().min(1), text: z.string().min(1) })).default([]),
});

export interface RunReviewsRouterDeps {
  judge?: JudgeLike;
  octokit?: OctokitLike;
  /** Override the budget guard (test seam). */
  budget?: RunPrReviewDeps["budget"];
}

export function runReviewsRouter(deps: RunReviewsRouterDeps = {}): Router {
  const r = Router();

  r.post("/", requireAuth, requirePermission("pr.review"), async (req: Request, res: Response) => {
    const parsed = triggerSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, "BAD_REQUEST", parsed.error.message);
    const judge = deps.judge;
    const octokit = deps.octokit;
    if (!judge || !octokit) {
      throw new AppError(503, "REVIEW_AGENT_UNAVAILABLE", "Judge or octokit not configured");
    }
    const budget = deps.budget ?? defaultBudgetDeps();

    // Pre-flight 429 — return BEFORE startRun so we don't pollute /runs
    // with no-op rows for over-budget projects.
    const status = await budget.check(parsed.data.projectId);
    if (!status.allowed) {
      res.status(429).json({
        success: false,
        error: "budget_exceeded",
        capCents: status.capCents,
        spentCents: status.spentCents,
        resetAt: status.resetAt,
      });
      return;
    }

    const runId = await startRun({
      sessionId: `pr-review-manual-${parsed.data.prNumber}-${Date.now()}`,
      projectId: parsed.data.projectId,
      kind: "tool",
    });
    try {
      const result = await runPrReview(
        {
          ...parsed.data,
          octokit,
          actor: { type: "user", id: req.user?.userId ?? null },
          prUrl: `https://github.com/${parsed.data.owner}/${parsed.data.repo}/pull/${parsed.data.prNumber}`,
        },
        { judge, budget },
      );
      await recordStep({ runId, kind: "tool_result", content: { kind: "pr_review", result } });
      await finishRun({ runId, status: "completed" });
      res.status(202).json(ok({ runId, result }));
    } catch (err) {
      await recordStep({
        runId,
        kind: "tool_result",
        content: { kind: "pr_review_error", error: (err as Error).message },
      });
      await finishRun({ runId, status: "failed" });
      throw new AppError(502, "REVIEW_FAILED", (err as Error).message);
    }
  });

  r.get(
    "/:runId",
    requireAuth,
    requirePermission("pr.review.read"),
    async (req: Request, res: Response) => {
      const runId = String(req.params.runId);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const run = await (prisma as any).agentRun.findUnique({ where: { id: runId } });
      if (!run) throw new AppError(404, "RUN_NOT_FOUND", "Run not found");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const steps = await (prisma as any).agentRunStep.findMany({
        where: { runId },
        orderBy: { ord: "asc" },
      });
      const reviewStep = steps.find((s: { content: string }) => {
        try {
          const c = JSON.parse(s.content);
          return c?.kind === "pr_review";
        } catch {
          return false;
        }
      });
      if (!reviewStep) {
        res.json(ok({ runId, review: null }));
        return;
      }
      const parsed = JSON.parse(reviewStep.content);
      res.json(ok({ runId, review: parsed.result }));
    },
  );

  return r;
}
