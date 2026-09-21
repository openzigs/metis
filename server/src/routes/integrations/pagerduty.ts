/**
 * Issue #580 (epic #63) — PagerDuty sev-1 alerting config routes.
 *
 * Workspace-admin surface to register/list/delete the per-(workspace, service)
 * PagerDuty routing key used for sev-1 incident alerting:
 *
 *   POST   /api/integrations/pagerduty/workspaces/:workspaceId/service-configs
 *   GET    /api/integrations/pagerduty/workspaces/:workspaceId/service-configs
 *   DELETE /api/integrations/pagerduty/workspaces/:workspaceId/service-configs/:serviceKey
 *
 * Registering/removing a routing key is an administrative configuration operation,
 * so every route requires `requireWorkspaceRole("admin")`. The workspace is taken
 * from the PATH (never the body) and enforced by the middleware, so a caller can
 * only ever configure their OWN workspace — a workspace's events can never be
 * routed through another workspace's routing key (tenant isolation).
 *
 * SECURITY: the routing key is accepted only on the POST body, encrypted into the
 * vault by the store, and is NEVER returned in any response (the summary surface
 * omits it). Mirrors the #67 notification-target route authz model.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { ApiResponse } from "@metis/shared";

import { requireAuth } from "../../middleware/auth.js";
import { requireWorkspaceRole } from "../../middleware/require-workspace-role.js";
import { AppError } from "../../middleware/error-handler.js";
import {
  getPagerDutyServiceConfigStore,
  PagerDutyServiceConfigError,
  type PagerDutyServiceConfigStore,
} from "../../lib/pagerduty/service-config-store.js";

type Req = Request & { params: Record<string, string> };

function ok<T>(data: T): ApiResponse<T> {
  return { success: true, data };
}

const registerSchema = z.object({
  serviceKey: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-zA-Z0-9_.\-:]+$/, "serviceKey may only contain letters, digits, _ . - :")
    .optional(),
  /** The PagerDuty routing (integration) key — write-only, encrypted at rest. */
  routingKey: z.string().min(1).max(512),
  label: z.string().max(200).nullable().optional(),
});

function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new AppError(400, "VALIDATION_ERROR", "Invalid payload", { issues: parsed.error.errors });
  }
  return parsed.data;
}

function asAppError(err: unknown): AppError {
  if (err instanceof PagerDutyServiceConfigError) {
    return new AppError(err.statusCode, err.code, err.message);
  }
  if (err instanceof AppError) return err;
  return new AppError(500, "PAGERDUTY_ERROR", "PagerDuty integration error");
}

export function pagerDutyIntegrationRouter(
  store: PagerDutyServiceConfigStore = getPagerDutyServiceConfigStore(),
): Router {
  const r = Router();

  // POST .../service-configs — register/re-point a PagerDuty routing key.
  r.post(
    "/workspaces/:workspaceId/service-configs",
    requireAuth,
    requireWorkspaceRole("admin"),
    async (req: Req, res: Response) => {
      const body = parse(registerSchema, req.body);
      try {
        const summary = await store.register({
          workspaceId: req.params.workspaceId,
          serviceKey: body.serviceKey,
          routingKey: body.routingKey,
          label: body.label ?? null,
          createdById: req.user?.userId ?? null,
        });
        res.status(201).json(ok(summary));
      } catch (err) {
        throw asAppError(err);
      }
    },
  );

  // GET .../service-configs — list the workspace's configs (secret-free).
  r.get(
    "/workspaces/:workspaceId/service-configs",
    requireAuth,
    requireWorkspaceRole("admin"),
    async (req: Req, res: Response) => {
      const configs = await store.listByWorkspace(req.params.workspaceId);
      res.json(ok(configs));
    },
  );

  // DELETE .../service-configs/:serviceKey — unregister + soft-delete the secret.
  r.delete(
    "/workspaces/:workspaceId/service-configs/:serviceKey",
    requireAuth,
    requireWorkspaceRole("admin"),
    async (req: Req, res: Response) => {
      const removed = await store.delete(req.params.workspaceId, req.params.serviceKey);
      if (!removed) {
        throw new AppError(404, "PAGERDUTY_CONFIG_NOT_FOUND", "No PagerDuty config for service");
      }
      res.json(ok({ deleted: true }));
    },
  );

  return r;
}
