/**
 * Issue #579 (epic #63) — Slack app admin + OAuth routes.
 *
 * Two surfaces (the Bolt slash-command/interactivity RECEIVER is mounted
 * separately in `slack-receiver.ts`, ahead of the JSON body parser, so it can do
 * its own raw-body signature verification):
 *
 *   ADMIN install management (workspace admin only):
 *     GET    /api/integrations/slack/workspaces/:workspaceId/installation
 *     POST   /api/integrations/slack/workspaces/:workspaceId/install   (direct token)
 *     DELETE /api/integrations/slack/workspaces/:workspaceId/installation
 *     GET    /api/integrations/slack/workspaces/:workspaceId/authorize  (OAuth start)
 *
 *   PUBLIC OAuth callback (no METIS auth — authenticity is the signed `state`):
 *     GET    /api/integrations/slack/oauth/callback
 *
 * SECURITY:
 *   - Every admin route requires `requireWorkspaceRole("admin")`; the workspace is
 *     taken from the PATH (never the body), so a caller can only configure their
 *     OWN workspace (tenant isolation).
 *   - The bot token is accepted only on the POST body (direct-install path) or via
 *     the OAuth exchange; either way it is encrypted into the vault by the store
 *     and NEVER returned in any response.
 *   - The OAuth callback authenticates via the HMAC-signed, time-bounded `state`
 *     (CSRF / install-fixation protection) — not a METIS session — and never
 *     echoes the code/token.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { ApiResponse } from "@metis/shared";

import { requireAuth } from "../../middleware/auth.js";
import { requireWorkspaceRole } from "../../middleware/require-workspace-role.js";
import { AppError } from "../../middleware/error-handler.js";
import { createChildLogger } from "../../lib/logger.js";
import {
  getSlackInstallationStore,
  SlackInstallationError,
  type SlackInstallationStore,
} from "../../lib/slack/installation-store.js";
import {
  buildAuthorizeUrl,
  completeSlackOAuth,
  signOAuthState,
  SlackOAuthError,
} from "../../lib/slack/oauth.js";
import {
  isSlackOAuthConfigured,
  loadSlackConfig,
  type SlackAppConfig,
} from "../../lib/slack/config.js";

const log = createChildLogger("slack-routes");

type Req = Request & { params: Record<string, string> };

function ok<T>(data: T): ApiResponse<T> {
  return { success: true, data };
}

const installSchema = z.object({
  slackTeamId: z.string().min(1).max(120),
  /** PLAINTEXT bot token — write-only, encrypted at rest, never returned. */
  botToken: z.string().min(1).max(512),
  slackTeamName: z.string().max(200).nullable().optional(),
  botUserId: z.string().max(120).nullable().optional(),
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
  if (err instanceof SlackInstallationError)
    return new AppError(err.statusCode, err.code, err.message);
  if (err instanceof SlackOAuthError) return new AppError(err.statusCode, err.code, err.message);
  if (err instanceof AppError) return err;
  return new AppError(500, "SLACK_ERROR", "Slack integration error");
}

export interface SlackRouterDeps {
  store?: SlackInstallationStore;
  config?: SlackAppConfig;
  /** The OAuth callback redirect URI registered with Slack. */
  redirectUri?: string | null;
}

export function slackIntegrationRouter(deps: SlackRouterDeps = {}): Router {
  const r = Router();
  const store = deps.store ?? getSlackInstallationStore();
  const config = deps.config ?? loadSlackConfig();
  const redirectUri = deps.redirectUri ?? null;

  // GET .../installation — secret-free summary (or 404 when none).
  r.get(
    "/workspaces/:workspaceId/installation",
    requireAuth,
    requireWorkspaceRole("admin"),
    async (req: Req, res: Response) => {
      const summary = await store.getByWorkspace(req.params.workspaceId);
      if (!summary) throw new AppError(404, "SLACK_NOT_INSTALLED", "No Slack app installed");
      res.json(ok(summary));
    },
  );

  // POST .../install — direct (non-OAuth) token registration. Useful for
  // single-tenant deploys that provision the token out-of-band.
  r.post(
    "/workspaces/:workspaceId/install",
    requireAuth,
    requireWorkspaceRole("admin"),
    async (req: Req, res: Response) => {
      const body = parse(installSchema, req.body);
      try {
        const summary = await store.install({
          workspaceId: req.params.workspaceId,
          slackTeamId: body.slackTeamId,
          botToken: body.botToken,
          slackTeamName: body.slackTeamName ?? null,
          botUserId: body.botUserId ?? null,
          label: body.label ?? null,
          createdById: req.user?.userId ?? null,
        });
        res.status(201).json(ok(summary));
      } catch (err) {
        throw asAppError(err);
      }
    },
  );

  // DELETE .../installation — revoke + soft-delete the vaulted token.
  r.delete(
    "/workspaces/:workspaceId/installation",
    requireAuth,
    requireWorkspaceRole("admin"),
    async (req: Req, res: Response) => {
      const removed = await store.uninstall(req.params.workspaceId);
      if (!removed) throw new AppError(404, "SLACK_NOT_INSTALLED", "No Slack app installed");
      res.json(ok({ deleted: true }));
    },
  );

  // GET .../authorize — begin the OAuth install (returns the Slack authorize URL
  // with a signed `state` binding the install to this workspace + admin).
  r.get(
    "/workspaces/:workspaceId/authorize",
    requireAuth,
    requireWorkspaceRole("admin"),
    async (req: Req, res: Response) => {
      if (!config.clientId || !isSlackOAuthConfigured(config)) {
        throw new AppError(503, "SLACK_OAUTH_NOT_CONFIGURED", "Slack OAuth is not configured");
      }
      const state = signOAuthState(
        { workspaceId: req.params.workspaceId, userId: req.user?.userId ?? null },
        config.stateSecret as string,
      );
      const url = buildAuthorizeUrl({
        clientId: config.clientId,
        scopes: config.scopes,
        state,
        redirectUri,
      });
      res.json(ok({ url }));
    },
  );

  // GET /oauth/callback — Slack redirects here after the admin authorizes. No
  // METIS auth: the signed `state` is the authenticity proof.
  r.get("/oauth/callback", async (req: Request, res: Response) => {
    if (!isSlackOAuthConfigured(config)) {
      throw new AppError(503, "SLACK_OAUTH_NOT_CONFIGURED", "Slack OAuth is not configured");
    }
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    try {
      const summary = await completeSlackOAuth({
        clientId: config.clientId as string,
        clientSecret: config.clientSecret as string,
        stateSecret: config.stateSecret as string,
        code,
        state,
        redirectUri,
        store,
      });
      log.info("Slack app installed via OAuth", {
        workspaceId: summary.workspaceId,
        slackTeamId: summary.slackTeamId,
      });
      res.json(ok({ installed: true, slackTeamId: summary.slackTeamId }));
    } catch (err) {
      throw asAppError(err);
    }
  });

  return r;
}
