/**
 * Epic #739 — Bidirectional Issue Sync routes.
 *
 * Webhook receivers:
 *   POST /api/webhooks/github/issues   — GitHub issue lifecycle events
 *   POST /api/webhooks/jira/issues     — Jira issue lifecycle events
 *
 * Drift management:
 *   GET  /api/sync/drift               — list drift events (project scoped)
 *   GET  /api/sync/drift/count         — drift count for badge
 *   POST /api/sync/drift/:id/resolve   — resolve a drift event
 */
import { Router, type Request, type Response } from "express";
import { resolveDriftSchema, type ApiResponse } from "@metis/shared";
import { ZodError } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { AppError } from "../middleware/error-handler.js";
import { webhookReceiverRateLimiter } from "../middleware/webhook-receiver-rate-limit.js";
import { recordDelivery } from "../lib/agents/pr-reviewer/webhook-dedup.js";
import {
  reconcileIssueChange,
  resolveDriftEvent,
  listDriftEvents,
  getDriftCount,
  verifyGithubIssueSignature,
  normalizeGithubIssueEvent,
  verifyJiraWebhookSignature,
  normalizeJiraIssueEvent,
} from "../lib/sync/index.js";
import type { ReconcileDeps } from "../lib/sync/index.js";
import { createChildLogger } from "../lib/logger.js";

const log = createChildLogger("sync-routes");

function ok<T>(data: T): ApiResponse<T> {
  return { success: true, data };
}

function rawBody(req: Request): string {
  const raw = (req as unknown as { rawBody?: string | Buffer }).rawBody;
  if (typeof raw === "string") return raw;
  if (raw instanceof Buffer) return raw.toString("utf8");
  return JSON.stringify(req.body ?? {});
}

export interface SyncRouterDeps {
  reconcileDeps?: ReconcileDeps;
  /** Override GitHub webhook secret resolver (test seam). */
  resolveGithubSecret?: () => string;
  /** Override Jira webhook secret resolver (test seam). */
  resolveJiraSecret?: () => string;
}

// ---- Webhook receivers (unauthenticated — verified by signature) -----------

export function syncWebhookRouter(deps: SyncRouterDeps = {}): Router {
  const r = Router();

  // #680 — throttle these UNAUTHENTICATED receivers (they are already
  // signature-first: the HMAC is verified before any DB work).
  r.use(webhookReceiverRateLimiter);

  /**
   * POST /github/issues — receive GitHub issue lifecycle webhooks.
   */
  r.post("/github/issues", async (req: Request, res: Response) => {
    const secret = deps.resolveGithubSecret?.() ?? process.env.GITHUB_WEBHOOK_SECRET ?? "";
    const sig = req.header("x-hub-signature-256") ?? undefined;
    const body = rawBody(req);

    const verify = verifyGithubIssueSignature(body, secret, sig);
    if (!verify.ok) {
      res.status(401).json({ ok: false, reason: verify.reason });
      return;
    }

    const eventType = req.header("x-github-event") ?? "";
    if (eventType !== "issues") {
      log.debug("sync.webhook.github.ignored_event", { eventType });
      res.status(200).json({ ok: true, handled: false, reason: "NOT_ISSUES_EVENT" });
      return;
    }

    // #681 — replay/dedup: GitHub signature carries no timestamp, so a captured
    // valid delivery can be replayed. Record the X-GitHub-Delivery UUID in the
    // shared dedup table and short-circuit re-deliveries, matching the PR-review
    // webhook path (webhooks-github.ts). An empty header is non-deduplicatable
    // (recordDelivery passes it through), so the header-less path is unchanged.
    const rawDelivery = (req.header("x-github-delivery") ?? "").trim();
    const dedup = await recordDelivery({ deliveryId: rawDelivery, eventType: "issues" });
    if (dedup.duplicate) {
      log.debug("sync.webhook.github.duplicate_delivery", { deliveryId: rawDelivery });
      res.status(200).json({ ok: true, handled: false, reason: "DUPLICATE_DELIVERY" });
      return;
    }

    const deliveryId = rawDelivery || crypto.randomUUID();
    const payload = req.body;

    const { event, reason } = normalizeGithubIssueEvent(payload, deliveryId);
    if (!event) {
      res.status(200).json({ ok: true, handled: false, reason });
      return;
    }

    const result = await reconcileIssueChange(event, deps.reconcileDeps);
    res.status(200).json({ ok: true, ...result });
  });

  /**
   * POST /jira/issues — receive Jira issue lifecycle webhooks.
   */
  r.post("/jira/issues", async (req: Request, res: Response) => {
    const secret = deps.resolveJiraSecret?.() ?? process.env.JIRA_WEBHOOK_SECRET ?? "";
    const sig =
      req.header("x-hub-signature") ?? req.header("x-atlassian-webhook-signature") ?? undefined;
    const body = rawBody(req);
    const payload = req.body;

    const verify = verifyJiraWebhookSignature(body, secret, {
      signature: sig,
      timestamp: payload?.timestamp,
    });
    if (!verify.ok) {
      res.status(401).json({ ok: false, reason: verify.reason });
      return;
    }

    // #681 — replay/dedup on the Atlassian delivery id (matches the GitHub path).
    // Jira validates a 5-min timestamp window but no nonce; the dedup row makes a
    // within-window replay a no-op.
    const rawDelivery = (
      req.header("x-atlassian-webhook-id") ??
      req.header("x-request-id") ??
      ""
    ).trim();
    const dedup = await recordDelivery({ deliveryId: rawDelivery, eventType: "jira-issue" });
    if (dedup.duplicate) {
      log.debug("sync.webhook.jira.duplicate_delivery", { deliveryId: rawDelivery });
      res.status(200).json({ ok: true, handled: false, reason: "DUPLICATE_DELIVERY" });
      return;
    }

    const deliveryId = rawDelivery || crypto.randomUUID();

    const { event, reason } = normalizeJiraIssueEvent(payload, deliveryId);
    if (!event) {
      res.status(200).json({ ok: true, handled: false, reason });
      return;
    }

    const result = await reconcileIssueChange(event, deps.reconcileDeps);
    res.status(200).json({ ok: true, ...result });
  });

  return r;
}

// ---- Drift management (authenticated) --------------------------------------

export function syncDriftRouter(): Router {
  const r = Router();
  r.use(requireAuth);

  /**
   * GET /drift — list drift events for a project.
   */
  r.get("/drift", requirePermission("sync.read"), async (req: Request, res: Response, next) => {
    try {
      const projectId = req.query.projectId as string;
      if (!projectId) throw new AppError(400, "INVALID_REQUEST", "projectId query param required");

      const status = req.query.status as string | undefined;
      const requirementId = req.query.requirementId as string | undefined;
      const page = Number(req.query.page) || 1;
      const perPage = Math.min(Number(req.query.perPage) || 20, 100);

      const result = await listDriftEvents(projectId, { status, requirementId, page, perPage });
      res.json(ok(result));
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /drift/count — drift count for badge display.
   */
  r.get(
    "/drift/count",
    requirePermission("sync.read"),
    async (req: Request, res: Response, next) => {
      try {
        const projectId = req.query.projectId as string;
        if (!projectId)
          throw new AppError(400, "INVALID_REQUEST", "projectId query param required");

        const count = await getDriftCount(projectId);
        res.json(ok({ count }));
      } catch (err) {
        next(err);
      }
    },
  );

  /**
   * POST /drift/:id/resolve — resolve a drift event.
   */
  r.post(
    "/drift/:id/resolve",
    requirePermission("sync.resolve"),
    async (req: Request, res: Response, next) => {
      try {
        if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");

        const { id } = req.params as { id: string };
        const body = resolveDriftSchema.parse(req.body);

        const result = await resolveDriftEvent(id, body.action, req.user.userId);
        res.json(ok(result));
      } catch (err: unknown) {
        if (err instanceof ZodError) {
          next(new AppError(400, "VALIDATION_ERROR", "Invalid request body"));
          return;
        }
        if (err instanceof Error && err.message === "DRIFT_NOT_FOUND") {
          next(new AppError(404, "NOT_FOUND", "Drift event not found"));
          return;
        }
        if (err instanceof Error && err.message === "ALREADY_RESOLVED") {
          next(new AppError(409, "CONFLICT", "Drift event already resolved"));
          return;
        }
        next(err);
      }
    },
  );

  return r;
}
