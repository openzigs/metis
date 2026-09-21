/**
 * Epic #165 (#114) — `/api/projects/:projectId/hooks` CRUD.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { requireProjectAccess } from "../middleware/require-project-access.js";
import { AppError } from "../middleware/error-handler.js";
import {
  HookConfigError,
  createSubscription,
  deleteSubscription,
  listSubscriptions,
  updateSubscription,
} from "../lib/hooks/index.js";
import { SDK_HOOK_EVENTS, SDK_HOOK_HANDLER_KINDS } from "@metis/shared";

function ok<T>(data: T): { success: true; data: T } {
  return { success: true, data };
}

function actorId(req: Request): string {
  if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
  return req.user.userId;
}

function rethrow(err: unknown): never {
  if (err instanceof HookConfigError) throw new AppError(400, "HOOK_CONFIG", err.message);
  throw err;
}

const eventSchema = z.enum(SDK_HOOK_EVENTS as unknown as [string, ...string[]]);
const kindSchema = z.enum(SDK_HOOK_HANDLER_KINDS as unknown as [string, ...string[]]);

const createSchema = z.object({
  event: eventSchema,
  handlerKind: kindSchema.default("webhook"),
  config: z.record(z.unknown()).default({}),
  enabled: z.boolean().default(true),
});

const patchSchema = z.object({
  event: eventSchema.optional(),
  handlerKind: kindSchema.optional(),
  config: z.record(z.unknown()).optional(),
  enabled: z.boolean().optional(),
});

export function hooksRouter(): Router {
  const r = Router({ mergeParams: true });

  // SECURITY (OWASP A01 / BOLA — epic #671, #675): two layers on every route.
  //  1. Object-level scope (`requireProjectAccess`) — the caller must be able to
  //     reach the `:projectId` in the path (mergeParams surfaces it here); a
  //     cross-tenant / unknown project → 404, no existence oracle, admin bypass.
  //  2. Role scope (`requirePermission`) — `mcp.read` to list, `mcp.manage` to
  //     mutate. Runs AFTER the object check so a wrong-tenant caller always sees
  //     404 regardless of role, keeping denials indistinguishable.
  // By-id mutations additionally scope the service query to `:projectId` so a
  // hook belonging to another project (even one the caller can reach) → 404.
  r.use(requireAuth, requireProjectAccess());

  r.get("/", requirePermission("mcp.read"), async (req: Request, res: Response) => {
    const projectId = (req.params as { projectId: string }).projectId;
    const subs = await listSubscriptions(projectId);
    res.json(ok(subs));
  });

  r.post("/", requirePermission("mcp.manage"), async (req: Request, res: Response) => {
    const projectId = (req.params as { projectId: string }).projectId;
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, "BAD_REQUEST", parsed.error.message);
    try {
      const created = await createSubscription(
        {
          projectId,
          event: parsed.data.event as never,
          handlerKind: parsed.data.handlerKind as never,
          config: parsed.data.config,
          enabled: parsed.data.enabled,
        },
        actorId(req),
      );
      res.status(201).json(ok(created));
    } catch (err) {
      rethrow(err);
    }
  });

  r.patch("/:id", requirePermission("mcp.manage"), async (req: Request, res: Response) => {
    const projectId = (req.params as { projectId: string }).projectId;
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, "BAD_REQUEST", parsed.error.message);
    try {
      const updated = await updateSubscription(
        projectId,
        String(req.params.id),
        {
          event: parsed.data.event as never,
          handlerKind: parsed.data.handlerKind as never,
          config: parsed.data.config,
          enabled: parsed.data.enabled,
        },
        actorId(req),
      );
      res.json(ok(updated));
    } catch (err) {
      rethrow(err);
    }
  });

  r.delete("/:id", requirePermission("mcp.manage"), async (req: Request, res: Response) => {
    const projectId = (req.params as { projectId: string }).projectId;
    try {
      await deleteSubscription(projectId, String(req.params.id), actorId(req));
      res.status(204).end();
    } catch (err) {
      rethrow(err);
    }
  });

  return r;
}
