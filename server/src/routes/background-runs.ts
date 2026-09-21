/**
 * Epic #156 (#146) — `/api/runs/background` routes.
 */
import { Router, type Request } from "express";
import { z } from "zod";
import type { ApiResponse } from "@metis/shared";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { AppError } from "../middleware/error-handler.js";
import { prisma } from "../lib/prisma.js";
import { getAsyncRunner } from "../lib/async/runner.js";
import { submitGroup } from "../lib/async/best-of-n.js";
import {
  authorizeBackgroundRun,
  authorizeRunGroup,
  authorizeRunProject,
  runProjectScope,
} from "../lib/async/run-authz.js";

function ok<T>(data: T): ApiResponse<T> {
  return { success: true, data };
}

function actorId(req: Request): string {
  if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
  return req.user.userId;
}

const KIND_VALUES = ["analysis", "chat", "browse", "custom"] as const;

const submitSchema = z.object({
  projectId: z.string().min(1),
  sessionId: z.string().optional(),
  kind: z.enum(KIND_VALUES),
  payload: z.record(z.unknown()).optional(),
  priority: z.number().int().min(0).max(10).optional(),
});

const groupSchema = z.object({
  projectId: z.string().min(1),
  kind: z.enum(KIND_VALUES),
  payload: z.record(z.unknown()).optional(),
  n: z.number().int().min(1).max(8),
  selectionMethod: z.enum(["highest-score", "judge-llm", "manual"]).optional(),
  strategy: z.enum(["best-of-n", "parallel"]).optional(),
});

const steerSchema = z.object({
  message: z.string().min(1).max(8000),
  role: z.enum(["system", "user", "agent"]).default("user"),
});

/**
 * Resolve the project owning run `:id` and assert the caller can reach it
 * (#1056). Returns the projectId to scope the follow-up query with —
 * `undefined` for system admins, who bypass workspace RBAC.
 */
function runScope(req: Request): Promise<string | undefined> {
  return authorizeBackgroundRun(req.user, String(req.params.id));
}

/** `where` fragment pinning a row to the caller's tenant (no-op for admins). */
function scopedById(id: string, projectId: string | undefined): { id: string; projectId?: string } {
  return { id, ...(projectId ? { projectId } : {}) };
}

export function backgroundRunsRouter(): Router {
  const r = Router();

  // POST /api/runs/background — submit a new background run.
  r.post("/background", requireAuth, requirePermission("analysis.run"), async (req, res) => {
    const parsed = submitSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, "BAD_REQUEST", parsed.error.message);
    actorId(req); // auth gate
    await authorizeRunProject(req.user, parsed.data.projectId);
    const runner = getAsyncRunner();
    const out = await runner.submit({
      projectId: parsed.data.projectId,
      sessionId: parsed.data.sessionId ?? null,
      kind: parsed.data.kind,
      payload: parsed.data.payload,
      priority: parsed.data.priority,
    });
    res.status(202).json(ok({ runId: out.id }));
  });

  // GET /api/runs/background?status=&projectId=
  r.get("/background", requireAuth, requirePermission("analysis.read"), async (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
    const limit = Math.min(
      Math.max(Number.parseInt(String(req.query.limit ?? "50"), 10) || 50, 1),
      200,
    );
    // An explicit filter is authorized directly; an unfiltered list is narrowed
    // to the caller's own projects so it cannot enumerate other tenants' runs.
    if (projectId) await authorizeRunProject(req.user, projectId);
    const items = await prisma.backgroundRun.findMany({
      where: {
        ...(status ? { status } : {}),
        ...(projectId ? { projectId } : runProjectScope(req.user)),
      },
      orderBy: [{ createdAt: "desc" }],
      take: limit,
    });
    res.json(ok({ items }));
  });

  r.get("/background/:id", requireAuth, requirePermission("analysis.read"), async (req, res) => {
    const scope = await runScope(req);
    const row = await prisma.backgroundRun.findFirst({
      where: scopedById(String(req.params.id), scope),
      include: { messages: { orderBy: { ord: "asc" } } },
    });
    if (!row) throw new AppError(404, "RUN_NOT_FOUND", "Background run not found");
    res.json(ok(row));
  });

  r.post(
    "/background/:id/cancel",
    requireAuth,
    requirePermission("analysis.run"),
    async (req, res) => {
      await runScope(req);
      const cancelled = await getAsyncRunner().cancel(String(req.params.id));
      if (!cancelled) throw new AppError(409, "RUN_TERMINAL", "Run cannot be cancelled");
      res.json(ok({ ok: true }));
    },
  );

  r.post(
    "/background/:id/pause",
    requireAuth,
    requirePermission("analysis.run"),
    async (req, res) => {
      await runScope(req);
      const paused = await getAsyncRunner().pause(String(req.params.id));
      if (!paused) throw new AppError(409, "RUN_NOT_RUNNING", "Run is not running");
      res.json(ok({ ok: true }));
    },
  );

  r.post(
    "/background/:id/resume",
    requireAuth,
    requirePermission("analysis.run"),
    async (req, res) => {
      await runScope(req);
      const resumed = await getAsyncRunner().resume(String(req.params.id));
      if (!resumed) throw new AppError(409, "RUN_NOT_PAUSED", "Run is not paused");
      res.json(ok({ ok: true }));
    },
  );

  // POST /api/runs/group — best-of-N
  r.post("/group", requireAuth, requirePermission("analysis.run"), async (req, res) => {
    const parsed = groupSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, "BAD_REQUEST", parsed.error.message);
    actorId(req);
    await authorizeRunProject(req.user, parsed.data.projectId);
    const out = await submitGroup({
      projectId: parsed.data.projectId,
      kind: parsed.data.kind,
      payload: parsed.data.payload,
      n: parsed.data.n,
      selectionMethod: parsed.data.selectionMethod,
      strategy: parsed.data.strategy,
    });
    res.status(202).json(ok(out));
  });

  r.get("/group/:id", requireAuth, requirePermission("analysis.read"), async (req, res) => {
    const scope = await authorizeRunGroup(req.user, String(req.params.id));
    const row = await prisma.runGroup.findFirst({
      where: scopedById(String(req.params.id), scope),
      include: { runs: { orderBy: { createdAt: "asc" } } },
    });
    if (!row) throw new AppError(404, "GROUP_NOT_FOUND", "Run group not found");
    res.json(ok(row));
  });

  // POST /api/runs/:id/steer — mid-run message queue. Steering injects text
  // into a live agent loop that runs with the owning project's context and
  // tool permissions, so the caller MUST be authorized against that project
  // before anything is queued (#1056).
  r.post("/:id/steer", requireAuth, requirePermission("analysis.run"), async (req, res) => {
    const parsed = steerSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, "BAD_REQUEST", parsed.error.message);
    const runId = String(req.params.id);
    const scope = await runScope(req);
    const run = await prisma.backgroundRun.findFirst({
      where: scopedById(runId, scope),
      select: { id: true, status: true },
    });
    if (!run) throw new AppError(404, "RUN_NOT_FOUND", "Background run not found");
    if (run.status !== "running" && run.status !== "queued" && run.status !== "paused") {
      throw new AppError(409, "RUN_TERMINAL", "Run has terminated");
    }
    const last = await prisma.runMessage.findFirst({
      where: { runId },
      orderBy: { ord: "desc" },
      select: { ord: true },
    });
    const ord = (last?.ord ?? -1) + 1;
    const created = await prisma.runMessage.create({
      data: {
        runId,
        ord,
        role: parsed.data.role,
        content: parsed.data.message,
      },
    });
    res.status(202).json(ok({ messageId: created.id, ord }));
  });

  return r;
}
