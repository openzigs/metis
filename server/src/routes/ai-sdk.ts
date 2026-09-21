/**
 * Epic #165 (#120, #121, #122) — Session-scoped controls layered on top of
 * `/api/ai`.
 *
 *   PATCH /api/ai/sessions/:id/model            — switch current model
 *   POST  /api/ai/sessions/:id/approve-plan     — approve|reject pending plan
 *   GET   /api/ai/sessions/:id/plan             — fetch latest plan
 *   GET   /api/ai/sessions?status=resumable     — resumable sessions
 *   POST  /api/ai/sessions/:id/resume           — rehydrate snapshot
 *
 * These hang off a separate router so the existing `/api/ai` module stays
 * focused on chat/streaming.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { AppError } from "../middleware/error-handler.js";
import { ModelSwitchError, switchModel } from "../lib/ai/model-switch.js";
import {
  PlanStateError,
  decidePlan,
  getCurrentPlan,
  recordPendingPlan,
} from "../lib/ai/plan-mode.js";
import { SessionSnapshotError, listResumable, rehydrate } from "../lib/ai/session-snapshot.js";
import { SDK_REASONING_EFFORTS } from "@metis/shared";
import { prisma } from "../lib/prisma.js";
import { compactSession } from "../lib/async/compaction.js";
import { getAsyncRunner } from "../lib/async/runner.js";

function ok<T>(data: T): { success: true; data: T } {
  return { success: true, data };
}

function actorId(req: Request): string {
  if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
  return req.user.userId;
}

function rethrow(err: unknown): never {
  if (err instanceof ModelSwitchError) throw new AppError(400, "MODEL_SWITCH", err.message);
  if (err instanceof PlanStateError) throw new AppError(409, "PLAN_STATE", err.message);
  if (err instanceof SessionSnapshotError) throw new AppError(404, "SESSION_RESUME", err.message);
  throw err;
}

async function assertOwner(req: Request, sessionId: string): Promise<void> {
  const userId = actorId(req);
  const row = await prisma.aISession.findUnique({
    where: { id: sessionId },
    select: { userId: true, deletedAt: true },
  });
  if (!row || row.deletedAt) throw new AppError(404, "NOT_FOUND", "Session not found");
  if (row.userId !== userId) throw new AppError(403, "FORBIDDEN", "Not your session");
}

const switchSchema = z.object({
  model: z.string().min(1).max(80),
  reasoningEffort: z.enum(SDK_REASONING_EFFORTS as unknown as [string, ...string[]]).nullish(),
});

const planDecisionSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
});

const planCreateSchema = z.object({
  planText: z.string().min(1).max(20_000),
});

const messageSchema = z.object({
  role: z.enum(["user", "system", "agent"]).default("user"),
  content: z.string().min(1).max(50_000),
});

export function aiSdkRouter(): Router {
  const r = Router();

  // GET /api/ai/sessions?status=resumable
  r.get("/sessions", requireAuth, async (req: Request, res: Response) => {
    if (req.query.status !== "resumable") {
      // The other listings live on the existing router; only handle the
      // resumable filter here so we don't conflict.
      res.json(ok([]));
      return;
    }
    const sessions = await listResumable(actorId(req));
    res.json(ok(sessions));
  });

  r.post("/sessions/:id/resume", requireAuth, async (req: Request, res: Response) => {
    await assertOwner(req, String(req.params.id));
    try {
      const result = await rehydrate(String(req.params.id));
      res.json(ok(result));
    } catch (err) {
      rethrow(err);
    }
  });

  r.patch("/sessions/:id/model", requireAuth, async (req: Request, res: Response) => {
    await assertOwner(req, String(req.params.id));
    const parsed = switchSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, "BAD_REQUEST", parsed.error.message);
    try {
      const result = await switchModel({
        sessionId: String(req.params.id),
        model: parsed.data.model,
        reasoningEffort: (parsed.data.reasoningEffort as never) ?? null,
        actorId: actorId(req),
      });
      res.json(ok(result));
    } catch (err) {
      rethrow(err);
    }
  });

  r.get("/sessions/:id/plan", requireAuth, async (req: Request, res: Response) => {
    await assertOwner(req, String(req.params.id));
    const plan = await getCurrentPlan(String(req.params.id));
    res.json(ok(plan));
  });

  // POST /api/ai/sessions/:id/plan — used by the orchestrator to record a
  // pending plan. Accepts only when no other plan is pending.
  r.post("/sessions/:id/plan", requireAuth, async (req: Request, res: Response) => {
    await assertOwner(req, String(req.params.id));
    const parsed = planCreateSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, "BAD_REQUEST", parsed.error.message);
    try {
      const plan = await recordPendingPlan(String(req.params.id), parsed.data.planText);
      res.status(201).json(ok(plan));
    } catch (err) {
      rethrow(err);
    }
  });

  r.post("/sessions/:id/approve-plan", requireAuth, async (req: Request, res: Response) => {
    await assertOwner(req, String(req.params.id));
    const parsed = planDecisionSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, "BAD_REQUEST", parsed.error.message);
    const plan = await getCurrentPlan(String(req.params.id));
    if (!plan) throw new AppError(404, "NOT_FOUND", "No plan to decide");
    if (plan.status !== "pending") {
      throw new AppError(409, "PLAN_STATE", `Plan already ${plan.status}`);
    }
    try {
      const decided = await decidePlan(plan.id, parsed.data.decision, actorId(req));
      res.json(ok(decided));
    } catch (err) {
      rethrow(err);
    }
  });

  // Epic #156 (#150) — POST /api/ai/sessions/:id/compact — on-demand
  // compaction triggered by the chat /compact slash command.
  r.post("/sessions/:id/compact", requireAuth, async (req: Request, res: Response) => {
    await assertOwner(req, String(req.params.id));
    try {
      const result = await compactSession(String(req.params.id));
      res.json(ok(result));
    } catch (err) {
      throw new AppError(500, "COMPACT_FAILED", (err as Error).message);
    }
  });

  // Epic #156 (#146) — POST /api/ai/sessions/:id/messages
  // Async is the DEFAULT: returns 202 { runId } and spawns a BackgroundRun(kind='chat').
  // Synchronous execution is not supported here; a caller who explicitly opts out
  // with ?async=false (or ?async=0) gets a 400 pointing at /api/ai/chat instead of a
  // misleading 501 dead-end.
  r.post("/sessions/:id/messages", requireAuth, async (req: Request, res: Response) => {
    await assertOwner(req, String(req.params.id));
    const parsed = messageSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, "BAD_REQUEST", parsed.error.message);
    const sessionId = String(req.params.id);
    const wantsSync = req.query.async === "false" || req.query.async === "0";
    const session = await prisma.aISession.findUnique({
      where: { id: sessionId },
      select: { projectId: true },
    });
    if (!session) throw new AppError(404, "NOT_FOUND", "Session not found");
    if (!session.projectId) throw new AppError(400, "NO_PROJECT", "Session has no project");

    if (wantsSync) {
      throw new AppError(
        400,
        "SYNC_NOT_SUPPORTED",
        "Synchronous message submission is not supported on this endpoint — omit ?async or use /api/ai/chat for synchronous chat.",
      );
    }

    const out = await getAsyncRunner().submit({
      projectId: session.projectId,
      sessionId,
      kind: "chat",
      payload: { message: parsed.data.content, role: parsed.data.role },
    });
    res.status(202).json(ok({ runId: out.id }));
  });

  return r;
}
