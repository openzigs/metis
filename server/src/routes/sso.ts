/**
 * SSO authentication routes — SAML 2.0 + OIDC.
 *
 * Epic #748, Issues #749, #750, #755.
 *
 * Endpoints:
 * - GET  /auth/sso/providers       — list enabled SSO providers (public, for login page)
 * - GET  /auth/saml/metadata       — SP metadata XML
 * - GET  /auth/saml/login          — initiate SAML SP-initiated login
 * - POST /auth/saml/acs            — Assertion Consumer Service (IdP callback)
 * - GET  /auth/oidc/login          — initiate OIDC authorization code + PKCE
 * - GET  /auth/oidc/callback       — OIDC authorization code callback
 */
import { Router, type Request, type Response } from "express";
import type { RoleKey, ApiResponse } from "@metis/shared";
import { getPermissionsForRole } from "@metis/shared";
import {
  getPublicEnabledProviders,
  getProviderByMode,
  resolveRoleFromGroups,
} from "../lib/auth/sso-config.js";
import {
  generateSPMetadata,
  validateSAMLResponse,
  generateAuthnRequestUrl,
} from "../lib/auth/saml-provider.js";
import { generateAuthorizationUrl, exchangeCodeForTokens } from "../lib/auth/oidc-provider.js";
import { reconcileTrustedLoginRole } from "../lib/auth/durable-roles.js";
import { issueTokens } from "../lib/auth/jwt.js";
import { audit } from "../lib/audit/audit-service.js";
import { prisma } from "../lib/prisma.js";
import { AppError } from "../middleware/error-handler.js";
import { resolveSSOStateStore, type SSOStateStore } from "../lib/auth/sso-state-store.js";
import type { CookieOptions } from "express";

/**
 * SSO transaction-state TTL (ms). The state (PKCE codeVerifier + OIDC nonce) is
 * only needed for the seconds between the authorize redirect and the callback;
 * a short TTL bounds the replay window and keeps the shared store tiny. Replaces
 * the old 10-minute in-process cleanup sweep (#542).
 */
const SSO_STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Resolved SSO transaction-state store (#542). `memory` (default) is per-process
 * for single-replica dev/local; `postgres` (SSO_STATE_BACKEND=postgres) is the
 * replica-safe production backend so the initiate→callback handshake survives
 * load balancing across pods. Resolved once per process (lazy singleton) so the
 * Postgres backend reuses one connection/table-bootstrap.
 */
let ssoStateStore: SSOStateStore | undefined;
function getSSOStateStore(): SSOStateStore {
  ssoStateStore ??= resolveSSOStateStore();
  return ssoStateStore;
}

function cookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
  };
}

async function readWorkspaceIds(userId: string): Promise<string[]> {
  const workspaceMemberModel = prisma.workspaceMember as unknown as {
    findMany?: (args: {
      where: { userId: string };
      select: { workspaceId: true };
    }) => Promise<Array<{ workspaceId: string }> | undefined>;
  };
  if (typeof workspaceMemberModel.findMany !== "function") {
    return [];
  }
  const memberships = await workspaceMemberModel.findMany({
    where: { userId },
    select: { workspaceId: true },
  });
  return Array.isArray(memberships) ? memberships.map((membership) => membership.workspaceId) : [];
}

async function ensureUserRow(
  username: string,
  displayName: string,
  email: string,
  role: RoleKey,
): Promise<{ id: string; role: RoleKey }> {
  const row = await prisma.user.upsert({
    where: { username },
    update: { displayName, email, lastLoginAt: new Date() },
    create: {
      username,
      displayName,
      email,
      status: "active",
      lastLoginAt: new Date(),
      authRolesInitializedAt: null,
    },
  });
  try {
    return {
      id: row.id,
      role: await reconcileTrustedLoginRole({
        userId: row.id,
        providerRole: role,
        authRolesInitializedAt:
          (row as { authRolesInitializedAt?: Date | null }).authRolesInitializedAt ?? null,
      }),
    };
  } catch (error) {
    if (error instanceof Error && error.message.includes("Configured role")) {
      throw new AppError(500, "ROLE_NOT_FOUND", error.message);
    }
    throw error;
  }
}

export function ssoRouter(): Router {
  const r = Router();

  // --- Public: list enabled providers for login page (#755, #429) ---
  // Pre-auth endpoint: the `/login` page is unauthenticated, so this returns the
  // SAFE display projection only ({ id, label, type, loginUrl }). Secrets in the
  // stored SAML/OIDC config are structurally unreachable here — see
  // `getPublicEnabledProviders` / `toPublicProvider` (OWASP A01/A05). When no
  // providers are configured this returns an empty list with 200 (not 404/500),
  // and it reads the live in-memory config so an admin can enable a provider and
  // have its button appear on /login without a redeploy.
  r.get("/sso/providers", (_req: Request, res: Response) => {
    const providers = getPublicEnabledProviders();
    const body: ApiResponse = { success: true, data: { providers } };
    res.json(body);
  });

  // --- SAML: SP Metadata (#749) ---
  r.get("/saml/metadata", (_req: Request, res: Response) => {
    const provider = getProviderByMode("saml");
    if (!provider?.saml) {
      throw new AppError(404, "SSO_NOT_CONFIGURED", "SAML provider is not configured");
    }
    const metadata = generateSPMetadata(provider.saml);
    res.type("application/xml").send(metadata);
  });

  // --- SAML: Initiate login ---
  r.get("/saml/login", async (_req: Request, res: Response) => {
    const provider = getProviderByMode("saml");
    if (!provider?.saml) {
      throw new AppError(404, "SSO_NOT_CONFIGURED", "SAML provider is not configured");
    }
    const url = await generateAuthnRequestUrl(provider.saml);
    res.redirect(url);
  });

  // --- SAML: Assertion Consumer Service (#749) ---
  r.post("/saml/acs", async (req: Request, res: Response) => {
    const provider = getProviderByMode("saml");
    if (!provider?.saml) {
      throw new AppError(404, "SSO_NOT_CONFIGURED", "SAML provider is not configured");
    }
    const samlResponse = req.body?.SAMLResponse;
    if (!samlResponse || typeof samlResponse !== "string") {
      throw new AppError(400, "INVALID_SAML_RESPONSE", "Missing SAMLResponse in POST body");
    }

    const result = await validateSAMLResponse(samlResponse, provider.saml);
    if (!result.success || !result.user) {
      audit({
        actor: null,
        action: "user.login.failed",
        target: { type: "user", id: "saml-unknown" },
        metadata: { reason: result.error, mode: "saml" },
      });
      throw new AppError(401, "SAML_AUTH_FAILED", result.error ?? "SAML authentication failed");
    }

    const role = resolveRoleFromGroups(
      result.user.groups,
      provider.groupMappings,
      provider.defaultRole,
    );
    const userRow = await ensureUserRow(
      result.user.username,
      result.user.displayName,
      result.user.email,
      role,
    );
    const permissions = getPermissionsForRole(userRow.role);
    const tokens = issueTokens({
      userId: userRow.id,
      username: result.user.username,
      role: userRow.role,
      permissions,
      workspaces: await readWorkspaceIds(userRow.id),
    });

    res.cookie("accessToken", tokens.accessToken, { ...cookieOptions(), maxAge: 60 * 60 * 1000 });
    res.cookie("refreshToken", tokens.refreshToken, {
      ...cookieOptions(),
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    audit({
      actor: { id: userRow.id },
      action: "user.login",
      target: { type: "user", id: userRow.id },
      metadata: {
        username: result.user.username,
        role: userRow.role,
        mode: "saml",
        mfaPassed: result.user.mfaPassed,
      },
    });

    // Redirect to dashboard after successful SSO
    const baseUrl = process.env.APP_URL ?? "http://localhost:3000";
    res.redirect(`${baseUrl}/dashboard`);
  });

  // --- OIDC: Initiate login (#750) ---
  r.get("/oidc/login", async (_req: Request, res: Response) => {
    const provider = getProviderByMode("oidc");
    if (!provider?.oidc) {
      throw new AppError(404, "SSO_NOT_CONFIGURED", "OIDC provider is not configured");
    }

    const { url, codeVerifier, state, nonce } = await generateAuthorizationUrl(provider.oidc);
    // Stash the per-transaction state in the shared store so the callback can
    // retrieve it from ANY replica (#542). TTL bounds the replay window; the
    // store expires/prunes stale entries (replaces the old in-process cleanup).
    await getSSOStateStore().put(state, { codeVerifier, nonce, mode: "oidc" }, SSO_STATE_TTL_MS);
    res.redirect(url);
  });

  // --- OIDC: Callback (#750) ---
  r.get("/oidc/callback", async (req: Request, res: Response) => {
    const provider = getProviderByMode("oidc");
    if (!provider?.oidc) {
      throw new AppError(404, "SSO_NOT_CONFIGURED", "OIDC provider is not configured");
    }

    const code = req.query.code as string | undefined;
    const state = req.query.state as string | undefined;
    const error = req.query.error as string | undefined;

    if (error) {
      throw new AppError(401, "OIDC_AUTH_FAILED", `IdP returned error: ${error}`);
    }
    if (!code || !state) {
      throw new AppError(400, "INVALID_OIDC_CALLBACK", "Missing code or state parameter");
    }

    // Atomic consume-once from the shared store: reads AND deletes the entry in
    // one step, so a `state` cannot be replayed (a second callback misses) and
    // the lookup succeeds regardless of which replica handled the initiate (#542).
    // Returns null for unknown / already-consumed / expired (past-TTL) state.
    const session = await getSSOStateStore().consume(state);
    if (!session) {
      throw new AppError(
        401,
        "OIDC_STATE_MISMATCH",
        "Invalid or expired state parameter (replay attack window exceeded)",
      );
    }

    const result = await exchangeCodeForTokens(
      provider.oidc,
      code,
      session.codeVerifier,
      session.nonce,
    );
    if (!result.success || !result.user) {
      audit({
        actor: null,
        action: "user.login.failed",
        target: { type: "user", id: "oidc-unknown" },
        metadata: { reason: result.error, mode: "oidc" },
      });
      throw new AppError(401, "OIDC_AUTH_FAILED", result.error ?? "OIDC authentication failed");
    }

    const role = resolveRoleFromGroups(
      result.user.groups,
      provider.groupMappings,
      provider.defaultRole,
    );
    const userRow = await ensureUserRow(
      result.user.username,
      result.user.displayName,
      result.user.email,
      role,
    );
    const permissions = getPermissionsForRole(userRow.role);
    const tokens = issueTokens({
      userId: userRow.id,
      username: result.user.username,
      role: userRow.role,
      permissions,
      workspaces: await readWorkspaceIds(userRow.id),
    });

    res.cookie("accessToken", tokens.accessToken, { ...cookieOptions(), maxAge: 60 * 60 * 1000 });
    res.cookie("refreshToken", tokens.refreshToken, {
      ...cookieOptions(),
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    audit({
      actor: { id: userRow.id },
      action: "user.login",
      target: { type: "user", id: userRow.id },
      metadata: {
        username: result.user.username,
        role: userRow.role,
        mode: "oidc",
        mfaPassed: result.user.mfaPassed,
      },
    });

    const baseUrl = process.env.APP_URL ?? "http://localhost:3000";
    res.redirect(`${baseUrl}/dashboard`);
  });

  return r;
}
