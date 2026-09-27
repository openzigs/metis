/**
 * /api/runs — deterministic-replay routes (#110, #153).
 *
 * Read-only over `AgentRun` and `AgentRunStep`. The `:id/replay` endpoint
 * returns the same payload as `:id`; the alternate name is purely for UI
 * clarity.
 *
 * Tenant isolation: every `:id*` route runs through `requireRunProjectAccess`
 * which loads the run, enforces project membership, and stashes the result
 * on `res.locals.run` so handlers re-use it without a second DB hit (#419).
 */
import { Router } from "express";
import type { ApiResponse } from "@metis/shared";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { requireRunProjectAccess } from "../middleware/require-run-project-access.js";
import { listRuns } from "../lib/replay/runs-service.js";
import { assertProjectAccess } from "../lib/custom-agents/authz.js";
import { isAdminActor, listAccessibleProjectIds } from "../lib/acp/authz.js";
import { AppError } from "../middleware/error-handler.js";
import { getSandboxSessionRepo } from "../lib/sandbox/repos/sandbox-session.repo.js";

function ok<T>(data: T): ApiResponse<T> {
  return { success: true, data };
}

function parseDate(value: unknown): Date | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return undefined;
  return d;
}

export function runsRouter(): Router {
  const r = Router();

  // #305 — an explicit `?projectId=` must name a project the caller can reach
  // (404 otherwise); every non-admin list, filtered or not, is narrowed to the
  // caller's projects, so `?sessionId=` cannot surface another tenant's runs.
  r.get("/", requireAuth, requirePermission("analysis.read"), async (req, res) => {
    if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
    const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : undefined;
    const from = parseDate(req.query.from);
    const to = parseDate(req.query.to);
    const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : undefined;
    if (projectId) await assertProjectAccess(req.user, projectId);
    const accessibleProjectIds = isAdminActor(req.user)
      ? undefined
      : await listAccessibleProjectIds(req.user);
    const items = await listRuns({ projectId, sessionId, from, to, limit, accessibleProjectIds });
    res.json(ok({ items }));
  });

  r.get(
    "/:id",
    requireAuth,
    requirePermission("analysis.read"),
    requireRunProjectAccess,
    (_req, res) => {
      res.json(ok(res.locals.run));
    },
  );

  // /replay is the same payload — naming is for UI clarity (no re-execute).
  r.get(
    "/:id/replay",
    requireAuth,
    requirePermission("analysis.read"),
    requireRunProjectAccess,
    (_req, res) => {
      res.json(ok(res.locals.run));
    },
  );

  /**
   * #419 — sandbox sessions for a single agent run. Returns the rows
   * that the run-detail page renders in the "Sandbox sessions" table.
   *
   * Tenant isolation: `requireRunProjectAccess` enforces project access on
   * the parent run before any sandbox data is read, so an `analysis.read`
   * token cannot enumerate other tenants' sandbox runs by guessing run ids.
   */
  r.get(
    "/:id/sandbox-sessions",
    requireAuth,
    requirePermission("analysis.read"),
    requireRunProjectAccess,
    async (req, res) => {
      const id = String(req.params.id);
      const sessions = await getSandboxSessionRepo().listForRun(id, { limit: 50 });
      res.json(
        ok({
          runId: id,
          sessions: sessions.map((s) => ({
            id: s.id,
            provider: s.provider,
            vendorSandboxId: s.vendorSandboxId,
            templateId: s.templateId,
            vCpus: s.vCpus,
            memMiB: s.memMiB,
            createdAt: s.createdAt,
            destroyedAt: s.destroyedAt,
            wallClockMs: s.wallClockMs,
            costMicroUsd: s.costMicroUsd,
            outcome: s.outcome,
            errorMessage: s.errorMessage,
          })),
        }),
      );
    },
  );

  return r;
}
