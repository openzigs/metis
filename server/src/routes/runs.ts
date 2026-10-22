/**
 * /api/runs — deterministic-replay routes (#110, #153).
 *
 * Read-only over `AgentRun` and `AgentRunStep`. The `:id/replay` endpoint
 * returns the same payload as `:id`; the alternate name is purely for UI
 * clarity.
 *
 * `GET /chat-turns` (#1007) reads the usage ledger instead: a chat turn is not
 * a run, and its cost is the ledger row the turn already wrote.
 *
 * Tenant isolation: every `:id*` route runs through `requireRunProjectAccess`
 * which loads the run, enforces project membership, and stashes the result
 * on `res.locals.run` so handlers re-use it without a second DB hit (#419).
 */
import { Router } from "express";
import type { ApiResponse, AuthPayload } from "@metis/shared";
import { requireAuth } from "../middleware/auth.js";
import { runsPreAuthRateLimiter, runsUserRateLimiter } from "../middleware/runs-rate-limit.js";
import { requirePermission } from "../middleware/require-permission.js";
import { requireRunProjectAccess } from "../middleware/require-run-project-access.js";
import { listRuns } from "../lib/replay/runs-service.js";
import { listChatTurns } from "../lib/ai/conversation/chat-turn-ledger.js";
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

/**
 * `?limit=`: a positive whole number, or absent. Anything else (`abc`, `-3`,
 * `0`, an array) is ignored like a malformed date, and the list's default page
 * size applies — `abc` used to be a 500 and `-3` returned rows.
 */
function parseLimit(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return undefined;
  const n = Number.parseInt(value, 10);
  return n > 0 ? n : undefined;
}

/**
 * #1122 — the project scope both lists apply, in one place. A non-admin is
 * narrowed to `listAccessibleProjectIds`, which leaves out a soft-deleted
 * project, and an explicit `?projectId=` outside that set answers
 * `assertProjectAccess`'s 404 — a soft-deleted project too, which
 * `assertProjectAccess` alone still admits, so it is not an empty 200. An
 * admin is not narrowed: a soft-deleted project stays open to them, as on
 * every other project surface (socket rooms, scheduler, discussions).
 *
 * Returns the project ids to narrow to; `undefined` for an admin.
 */
async function listProjectScope(
  user: AuthPayload,
  projectId: string | undefined,
): Promise<string[] | undefined> {
  if (projectId) await assertProjectAccess(user, projectId);
  if (isAdminActor(user)) return undefined;
  const accessible = await listAccessibleProjectIds(user);
  if (projectId && !accessible.includes(projectId)) {
    throw new AppError(404, "NOT_FOUND", "Project not found");
  }
  return accessible;
}

export function runsRouter(): Router {
  const r = Router();

  // #305 — an explicit `?projectId=` must name a project the caller can reach
  // (404 otherwise); every non-admin list, filtered or not, is narrowed to the
  // caller's projects, so `?sessionId=` cannot surface another tenant's runs.
  // #1122 — a soft-deleted project is not one a non-admin can reach.
  r.get(
    "/",
    runsPreAuthRateLimiter,
    requireAuth,
    runsUserRateLimiter,
    requirePermission("analysis.read"),
    async (req, res) => {
      if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
      const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
      const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : undefined;
      const from = parseDate(req.query.from);
      const to = parseDate(req.query.to);
      const limit = parseLimit(req.query.limit);
      const accessibleProjectIds = await listProjectScope(req.user, projectId);
      const items = await listRuns({ projectId, sessionId, from, to, limit, accessibleProjectIds });
      res.json(ok({ items }));
    },
  );

  // #1007 — chat turns are not runs; this lists them from the usage ledger so
  // a chat turn's cost can be read on `/runs`. Two rules narrow it:
  //   • project scope, exactly like the list above: an explicit `?projectId=`
  //     must be reachable (404 otherwise) and a non-admin is always narrowed
  //     to their own projects;
  //   • OWNERSHIP: only turns of chat sessions the caller owns, for an admin
  //     too. A chat session is owner-only everywhere else
  //     (`loadAuthorizedSession`), so a `?sessionId=` that is someone else's
  //     surfaces nothing. Unlike `loadAuthorizedSession`, a chat its owner
  //     DELETED is still listed to them: it is still their spend. A chat in a
  //     soft-deleted PROJECT is not, to a non-admin (#1122): the project is
  //     closed to them, so its turns leave the list and `?projectId=` of it
  //     is a 404, exactly as on the list above.
  // Registered before `/:id`.
  r.get(
    "/chat-turns",
    runsPreAuthRateLimiter,
    requireAuth,
    runsUserRateLimiter,
    requirePermission("analysis.read"),
    async (req, res) => {
      if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
      const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
      const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : undefined;
      const from = parseDate(req.query.from);
      const to = parseDate(req.query.to);
      const limit = parseLimit(req.query.limit);
      const accessibleProjectIds = await listProjectScope(req.user, projectId);
      const page = await listChatTurns({
        userId: req.user.userId,
        projectId,
        sessionId,
        from,
        to,
        limit,
        accessibleProjectIds,
      });
      res.json(ok(page));
    },
  );

  r.get(
    "/:id",
    runsPreAuthRateLimiter,
    requireAuth,
    runsUserRateLimiter,
    requirePermission("analysis.read"),
    requireRunProjectAccess,
    (_req, res) => {
      res.json(ok(res.locals.run));
    },
  );

  // /replay is the same payload — naming is for UI clarity (no re-execute).
  r.get(
    "/:id/replay",
    runsPreAuthRateLimiter,
    requireAuth,
    runsUserRateLimiter,
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
    runsPreAuthRateLimiter,
    requireAuth,
    runsUserRateLimiter,
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
