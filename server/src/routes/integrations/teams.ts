/**
 * Epic #547 (Phase 0, #548) — Microsoft Teams app foundation routes.
 *
 * Two surfaces:
 *
 *   PUBLIC bot endpoint (called by the Bot Framework channel service):
 *     POST /api/integrations/teams/messages?workspaceId=...
 *       — receives Bot Framework activities. Inbound authenticity is verified by
 *         the SDK CloudAdapter (Bot Framework JWT in the Authorization header)
 *         BEFORE any turn logic runs. A workspace with no installed credentials
 *         is rejected (we never run an auth-disabled adapter).
 *
 *   ADMIN install/connect flow (workspace-scoped, requires workspace admin):
 *     POST   /api/integrations/teams/workspaces/:workspaceId/install
 *     GET    /api/integrations/teams/workspaces/:workspaceId/installation
 *     DELETE /api/integrations/teams/workspaces/:workspaceId/installation
 *     GET    /api/integrations/teams/workspaces/:workspaceId/manifest
 *
 * The bot endpoint is intentionally NOT behind `requireAuth` (it is authenticated
 * by the Bot Framework JWT, not a METIS user token). The install endpoints ARE
 * behind `requireAuth` + `requireWorkspaceRole("admin")`.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { ApiResponse } from "@metis/shared";

import type { RoleKey } from "@metis/shared";

import { requireAuth } from "../../middleware/auth.js";
import { requireWorkspaceRole } from "../../middleware/require-workspace-role.js";
import { AppError } from "../../middleware/error-handler.js";
import { createChildLogger } from "../../lib/logger.js";
import {
  getTeamsInstallationStore,
  TeamsInstallationError,
  TEAMS_APP_TYPES,
  type TeamsInstallationStore,
} from "../../lib/teams/installation-store.js";
import { getConversationReferenceStore } from "../../lib/teams/conversation-reference-store.js";
import { getBotAdapterFactory } from "../../lib/teams/bot-adapter.js";
import { runFoundationTurn } from "../../lib/teams/bot-handler.js";
import { buildTeamsManifest, botMessagingEndpoint } from "../../lib/teams/manifest.js";
import {
  getTeamsChannelLinkStore,
  TeamsLinkError,
  type TeamsChannelLinkStore,
} from "../../lib/teams/channel-link-store.js";
import {
  getTeamsAadIdentityResolver,
  type TeamsAadIdentityResolver,
} from "../../lib/teams/aad-identity-resolver.js";
import {
  getTeamsNotificationTargetStore,
  TeamsNotificationTargetError,
  TEAMS_NOTIFICATION_EVENT_TYPES,
  type TeamsNotificationTargetStore,
} from "../../lib/teams/notification-target-store.js";
import { canAccessThread } from "../../lib/discussions/access.js";
import { prisma } from "../../lib/prisma.js";

const log = createChildLogger("teams-routes");

type Req = Request & { params: Record<string, string> };

function ok<T>(data: T): ApiResponse<T> {
  return { success: true, data };
}

const installSchema = z.object({
  appId: z.string().min(1).max(200),
  appPassword: z.string().min(1).max(2048),
  tenantId: z.string().min(1).max(200).nullable().optional(),
  appType: z.enum(TEAMS_APP_TYPES).optional(),
  label: z.string().max(200).nullable().optional(),
});

const manifestQuerySchema = z.object({
  packageId: z.string().min(1).max(200),
  botName: z.string().min(1).max(100).default("METIS"),
  publicHost: z.string().url(),
});

function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new AppError(400, "VALIDATION_ERROR", "Invalid payload", {
      issues: parsed.error.errors,
    });
  }
  return parsed.data;
}

/** Map a Teams domain error to the route's AppError contract. */
function asAppError(err: unknown): AppError {
  if (
    err instanceof TeamsInstallationError ||
    err instanceof TeamsLinkError ||
    err instanceof TeamsNotificationTargetError
  ) {
    return new AppError(err.statusCode, err.code, err.message);
  }
  if (err instanceof AppError) return err;
  return new AppError(500, "TEAMS_ERROR", "Teams integration error");
}

function actorFromReq(req: Request): { id: string; role: RoleKey } {
  if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
  return { id: req.user.userId, role: req.user.role as RoleKey };
}

/** Map a `canAccessThread` denial to the right HTTP error. */
function threadDenyToError(reason: "not_found" | "forbidden"): AppError {
  return reason === "not_found"
    ? new AppError(404, "THREAD_NOT_FOUND", "Discussion thread not found")
    : new AppError(403, "FORBIDDEN", "No access to this discussion thread");
}

const createLinkSchema = z.object({
  threadId: z.string().min(1).max(200),
  conversationId: z.string().min(1).max(1024),
  channelId: z.string().min(1).max(200).default("msteams"),
  tenantId: z.string().min(1).max(200).nullable().optional(),
});

const notificationTargetSchema = z.object({
  /** Which event routes to this channel (free-form list of known events). */
  eventType: z.enum(TEAMS_NOTIFICATION_EVENT_TYPES),
  conversationId: z.string().min(1).max(1024),
  channelId: z.string().min(1).max(200).default("msteams"),
  tenantId: z.string().min(1).max(200).nullable().optional(),
  /**
   * The Bot Framework `ConversationReference` for the destination channel, used
   * for the proactive send. Captured by the operator from a channel the bot is
   * installed in (the same reference the #548 store records on inbound activity).
   */
  reference: z.record(z.unknown()),
});

const linkIdentitySchema = z.object({
  tenantId: z.string().min(1).max(200),
  aadObjectId: z.string().min(1).max(200),
  /** Provide exactly one of email (SSO match) or userId (explicit admin link). */
  email: z.string().email().max(320).optional(),
  userId: z.string().min(1).max(200).optional(),
});

export function teamsIntegrationRouter(
  store: TeamsInstallationStore = getTeamsInstallationStore(),
  linkStore: TeamsChannelLinkStore = getTeamsChannelLinkStore(),
  identityResolver: TeamsAadIdentityResolver = getTeamsAadIdentityResolver(),
  notificationTargetStore: TeamsNotificationTargetStore = getTeamsNotificationTargetStore(),
): Router {
  const r = Router();

  // ── PUBLIC bot messaging endpoint ────────────────────────────────────────
  // Authenticity is enforced by the Bot Framework JWT the CloudAdapter validates.
  r.post("/messages", async (req: Request, res: Response) => {
    const workspaceId = (req.query.workspaceId as string | undefined)?.trim();
    if (!workspaceId) {
      // No workspace routing key — cannot select credentials to validate against.
      res.status(400).json({
        success: false,
        error: { code: "WORKSPACE_REQUIRED", message: "workspaceId query param is required" },
      });
      return;
    }

    let creds;
    try {
      creds = await store.resolveAppPassword(workspaceId);
    } catch (err) {
      log.error("Failed to resolve Teams credentials", {
        workspaceId,
        message: (err as Error).message,
      });
      res.status(500).json({
        success: false,
        error: { code: "TEAMS_CREDENTIALS_ERROR", message: "Could not resolve bot credentials" },
      });
      return;
    }

    if (!creds) {
      // No installed credentials → we refuse to run an auth-disabled adapter that
      // would accept unsigned activities (the security hole this must not open).
      res.status(403).json({
        success: false,
        error: { code: "TEAMS_NOT_INSTALLED", message: "No Teams app installed for workspace" },
      });
      return;
    }

    const installation = await store.getByWorkspace(workspaceId);
    const refStore = getConversationReferenceStore();
    const adapter = getBotAdapterFactory()(creds);

    // The adapter validates the inbound Bot Framework JWT; an invalid/expired/
    // unsigned activity is rejected by `process` (it sets a 401 on `res` and the
    // turn logic never runs). Auth failures surface as a thrown error → 401.
    try {
      await adapter.process(req, res, (context) =>
        runFoundationTurn(context, {
          workspaceId,
          installationId: installation?.id ?? "",
          store: refStore,
        }),
      );
    } catch (err) {
      log.warn("Teams activity rejected", { workspaceId, message: (err as Error).message });
      if (!res.headersSent) {
        res.status(401).json({
          success: false,
          error: { code: "TEAMS_ACTIVITY_UNAUTHORIZED", message: "Activity failed authentication" },
        });
      }
    }
  });

  // ── ADMIN install flow (workspace-scoped) ────────────────────────────────
  r.post(
    "/workspaces/:workspaceId/install",
    requireAuth,
    requireWorkspaceRole("admin"),
    async (req: Req, res: Response) => {
      const body = parse(installSchema, req.body);
      try {
        const summary = await store.install({
          workspaceId: req.params.workspaceId,
          appId: body.appId,
          appPassword: body.appPassword,
          tenantId: body.tenantId ?? null,
          appType: body.appType,
          label: body.label ?? null,
          createdById: req.user?.userId ?? null,
        });
        res.status(201).json(ok(summary));
      } catch (err) {
        throw asAppError(err);
      }
    },
  );

  r.get(
    "/workspaces/:workspaceId/installation",
    requireAuth,
    requireWorkspaceRole("admin"),
    async (req: Req, res: Response) => {
      const summary = await store.getByWorkspace(req.params.workspaceId);
      if (!summary) {
        throw new AppError(404, "TEAMS_NOT_INSTALLED", "No Teams app installed for workspace");
      }
      res.json(ok(summary));
    },
  );

  r.delete(
    "/workspaces/:workspaceId/installation",
    requireAuth,
    requireWorkspaceRole("admin"),
    async (req: Req, res: Response) => {
      const removed = await store.uninstall(req.params.workspaceId);
      if (!removed) {
        throw new AppError(404, "TEAMS_NOT_INSTALLED", "No Teams app installed for workspace");
      }
      res.json(ok({ uninstalled: true }));
    },
  );

  // Manifest scaffolding — returns the manifest.json a developer uploads to Teams.
  r.get(
    "/workspaces/:workspaceId/manifest",
    requireAuth,
    requireWorkspaceRole("admin"),
    async (req: Req, res: Response) => {
      const q = parse(manifestQuerySchema, req.query);
      const installation = await store.getByWorkspace(req.params.workspaceId);
      if (!installation) {
        throw new AppError(404, "TEAMS_NOT_INSTALLED", "No Teams app installed for workspace");
      }
      const manifest = buildTeamsManifest({
        appId: installation.appId,
        packageId: q.packageId,
        botName: q.botName,
        publicHost: q.publicHost,
      });
      res.json(
        ok({
          manifest,
          messagingEndpoint: `${botMessagingEndpoint(q.publicHost)}?workspaceId=${req.params.workspaceId}`,
        }),
      );
    },
  );

  // ── Phase 1 (#549): thread ↔ Teams-channel LINKS (member-only) ────────────
  // Authorization is the discussions member-only check (`canAccessThread`): only
  // a workspace member on the thread's project may link/list/unlink. The
  // workspace is DERIVED from the thread's project (never trusted from the body),
  // so a caller cannot link a thread into a workspace they don't belong to.

  // POST .../workspaces/:workspaceId/links — link a thread to a Teams channel.
  r.post("/workspaces/:workspaceId/links", requireAuth, async (req: Req, res: Response) => {
    const actor = actorFromReq(req);
    const body = parse(createLinkSchema, req.body);
    const workspaceId = req.params.workspaceId;

    // Member-only on the thread's project (also resolves projectId).
    const access = await canAccessThread(actor, body.threadId);
    if (!access.ok) throw threadDenyToError(access.reason);

    // The thread's project MUST belong to the workspace in the path — this is
    // the tenant-scoping boundary for the link.
    const project = await prisma.project.findFirst({
      where: { id: access.projectId },
      select: { workspaceId: true },
    });
    if (!project || project.workspaceId !== workspaceId) {
      throw new AppError(
        403,
        "WORKSPACE_MISMATCH",
        "Thread does not belong to the target workspace",
      );
    }

    try {
      const link = await linkStore.create({
        workspaceId,
        threadId: body.threadId,
        projectId: access.projectId,
        conversationId: body.conversationId,
        channelId: body.channelId,
        tenantId: body.tenantId ?? null,
        createdById: actor.id,
      });
      res.status(201).json(ok(link));
    } catch (err) {
      throw asAppError(err);
    }
  });

  // GET .../workspaces/:workspaceId/links — list workspace links (member view).
  // Each row is still member-gated by the thread it points at, so we filter the
  // workspace list down to threads the actor may access.
  r.get("/workspaces/:workspaceId/links", requireAuth, async (req: Req, res: Response) => {
    const actor = actorFromReq(req);
    const all = await linkStore.listByWorkspace(req.params.workspaceId);
    const visible = [];
    for (const link of all) {
      const access = await canAccessThread(actor, link.threadId);
      if (access.ok) visible.push(link);
    }
    res.json(ok(visible));
  });

  // DELETE .../workspaces/:workspaceId/links/:linkId — unlink (member-only).
  r.delete(
    "/workspaces/:workspaceId/links/:linkId",
    requireAuth,
    async (req: Req, res: Response) => {
      const actor = actorFromReq(req);
      const workspaceId = req.params.workspaceId;
      const links = await linkStore.listByWorkspace(workspaceId);
      const target = links.find((l) => l.id === req.params.linkId);
      if (!target) {
        throw new AppError(404, "LINK_NOT_FOUND", "Teams channel link not found");
      }
      // Member-only on the linked thread before allowing the unlink.
      const access = await canAccessThread(actor, target.threadId);
      if (!access.ok) throw threadDenyToError(access.reason);

      const removed = await linkStore.delete(workspaceId, req.params.linkId);
      if (!removed) throw new AppError(404, "LINK_NOT_FOUND", "Teams channel link not found");
      res.json(ok({ unlinked: true }));
    },
  );

  // ── Phase 1 (#549): AAD → METIS user identity binding (workspace admin) ───
  // Establishing/removing an identity binding is an administrative mapping
  // operation, so it requires workspace admin. The runtime resolver itself
  // (resolveUserFromAadObjectId) is consumed by later phases, not exposed here.
  r.post(
    "/workspaces/:workspaceId/identities",
    requireAuth,
    requireWorkspaceRole("admin"),
    async (req: Req, res: Response) => {
      const body = parse(linkIdentitySchema, req.body);
      const workspaceId = req.params.workspaceId;
      if (!body.email && !body.userId) {
        throw new AppError(400, "VALIDATION_ERROR", "Provide either email or userId to link");
      }

      const outcome = body.userId
        ? await identityResolver.linkExplicit({
            workspaceId,
            tenantId: body.tenantId,
            aadObjectId: body.aadObjectId,
            userId: body.userId,
          })
        : await identityResolver.linkByEmail({
            workspaceId,
            tenantId: body.tenantId,
            aadObjectId: body.aadObjectId,
            email: body.email as string,
          });

      if (!outcome.ok) {
        // Never silently attribute: a no-match is an explicit, clear failure.
        throw new AppError(
          404,
          "AAD_USER_UNMAPPED",
          "No active METIS user matches the supplied identity — sender left unmapped",
        );
      }
      res
        .status(201)
        .json(
          ok({ tenantId: body.tenantId, aadObjectId: body.aadObjectId, userId: outcome.userId }),
        );
    },
  );

  // ── Issue #67: one-way notification TARGETS (workspace admin) ─────────────
  // Registering/removing a per-event notification destination is an
  // administrative config operation (it controls where operational alerts are
  // proactively pushed), so it requires workspace admin. The workspace is taken
  // from the path and enforced by `requireWorkspaceRole("admin")`, so a caller
  // can only ever configure their OWN workspace's targets — a notification can
  // never be routed into another workspace's Teams channel.

  // POST .../workspaces/:workspaceId/notification-targets — register/re-point.
  r.post(
    "/workspaces/:workspaceId/notification-targets",
    requireAuth,
    requireWorkspaceRole("admin"),
    async (req: Req, res: Response) => {
      const body = parse(notificationTargetSchema, req.body);
      try {
        const target = await notificationTargetStore.register({
          workspaceId: req.params.workspaceId,
          eventType: body.eventType,
          conversationId: body.conversationId,
          channelId: body.channelId,
          tenantId: body.tenantId ?? null,
          reference: body.reference,
          createdById: req.user?.userId ?? null,
        });
        res.status(201).json(ok(target));
      } catch (err) {
        throw asAppError(err);
      }
    },
  );

  // GET .../workspaces/:workspaceId/notification-targets — list workspace targets.
  r.get(
    "/workspaces/:workspaceId/notification-targets",
    requireAuth,
    requireWorkspaceRole("admin"),
    async (req: Req, res: Response) => {
      const targets = await notificationTargetStore.listByWorkspace(req.params.workspaceId);
      res.json(ok(targets));
    },
  );

  // DELETE .../workspaces/:workspaceId/notification-targets/:eventType — unregister.
  r.delete(
    "/workspaces/:workspaceId/notification-targets/:eventType",
    requireAuth,
    requireWorkspaceRole("admin"),
    async (req: Req, res: Response) => {
      const removed = await notificationTargetStore.delete(
        req.params.workspaceId,
        req.params.eventType,
      );
      if (!removed) {
        throw new AppError(
          404,
          "NOTIFICATION_TARGET_NOT_FOUND",
          "No notification target for event",
        );
      }
      res.json(ok({ deleted: true }));
    },
  );

  return r;
}
