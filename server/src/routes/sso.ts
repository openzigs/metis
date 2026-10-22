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
import {
  getPermissionsForRole,
  SESSION_ACCESS_COOKIE,
  SESSION_ACCESS_MAX_AGE_SECONDS,
  SESSION_REFRESH_COOKIE,
  SESSION_REFRESH_MAX_AGE_SECONDS,
} from "@metis/shared";
import {
  DEFAULT_CORS_ORIGIN,
  normaliseOrigin,
  parseCorsOrigins,
} from "../lib/config/cors-origins.js";
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
import { oidcAssertedIdentities, samlAssertedIdentities } from "../lib/auth/bootstrap-admins.js";
import {
  oidcIdentity,
  resolveLoginUser,
  samlIdentity,
  type ExternalIdentity,
  type LoginProfile,
} from "../lib/auth/login-identity.js";
import { getAuthProvider } from "../lib/auth/providers.js";
import { issueTokens } from "../lib/auth/jwt.js";
import { LIVE_WORKSPACE_MEMBERSHIP } from "../lib/auth/live-workspace-ids.js";
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

/**
 * #1386 — finish an SSO login with the session the UI reads.
 *
 * The browser's session lives in the UI's `metis.at` / `metis.rt` cookies; the
 * UI turns the access cookie into the API's Bearer header. These handlers used
 * to set `accessToken` / `refreshToken` instead, which nothing in the UI reads,
 * so every SSO login landed on a page that sent the user back to `/login`.
 *
 * Cookies are scoped to a host, not a port, and the Ingress serves these routes
 * on the UI's own host (`/api/auth/oidc`, `/api/auth/saml` → the server), so a
 * cookie set here is the UI's cookie. The attributes match the UI's own
 * (`ui/src/lib/edge-auth.ts`): `HttpOnly`, `SameSite=Lax` — set on the IdP's
 * cross-site redirect or POST and sent on the top-level navigation that follows
 * — and `Secure` in production, where the Ingress terminates TLS.
 */
function setBrowserSession(res: Response, tokens: { accessToken: string; refreshToken: string }) {
  const base: CookieOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
  };
  res.cookie(SESSION_ACCESS_COOKIE, tokens.accessToken, {
    ...base,
    maxAge: SESSION_ACCESS_MAX_AGE_SECONDS * 1000,
  });
  res.cookie(SESSION_REFRESH_COOKIE, tokens.refreshToken, {
    ...base,
    maxAge: SESSION_REFRESH_MAX_AGE_SECONDS * 1000,
  });
}

/**
 * Where a completed SSO login lands: `APP_URL`, else the UI origin `CORS_ORIGIN`
 * names (which every deployment behind an Ingress must set), else the dev UI.
 * Never a value from the request.
 */
export function ssoLandingUrl(): string {
  const configured =
    normaliseOrigin(process.env.APP_URL?.trim()) ??
    normaliseOrigin(parseCorsOrigins(process.env.CORS_ORIGIN ?? "")[0]) ??
    DEFAULT_CORS_ORIGIN;
  return `${configured}/dashboard`;
}

async function readWorkspaceIds(userId: string): Promise<string[]> {
  const workspaceMemberModel = prisma.workspaceMember as unknown as {
    findMany?: (args: {
      where: { userId: string; workspace: { deletedAt: null } };
      select: { workspaceId: true };
    }) => Promise<Array<{ workspaceId: string }> | undefined>;
  };
  if (typeof workspaceMemberModel.findMany !== "function") {
    return [];
  }
  const memberships = await workspaceMemberModel.findMany({
    // #549 — a soft-deleted workspace must not reach the token's scope claim.
    where: { userId, ...LIVE_WORKSPACE_MEMBERSHIP },
    select: { workspaceId: true },
  });
  return Array.isArray(memberships) ? memberships.map((membership) => membership.workspaceId) : [];
}

/**
 * The AUTH_MODE provider's kind — the only kind that may claim an account of
 * unknown provenance (#1395). Null when AUTH_MODE resolves to nothing usable
 * (the factory refuses mock in production), so such accounts stay unclaimed.
 */
function primaryAuthKind(): string | null {
  try {
    return getAuthProvider().name;
  } catch {
    return null;
  }
}

/**
 * #1395 — the local user for an SSO sign-in, keyed on the IdP's identity
 * (`login-identity.ts`), never on the username alone: a username already bound
 * to another provider's identity is refused with 409 ACCOUNT_LINK_REQUIRED.
 *
 * `bootstrapIdentities` (#1376) are the values matched against
 * `METIS_BOOTSTRAP_ADMINS`: only what the IdP vouches for.
 */
async function ensureUserRow(
  identity: ExternalIdentity | null,
  profile: LoginProfile,
  role: RoleKey,
  bootstrapIdentities: readonly (string | null)[],
): Promise<{ id: string; username: string; role: RoleKey }> {
  if (!identity) {
    throw new AppError(401, "SSO_IDENTITY_MISSING", "The IdP did not identify the user");
  }
  const row = await resolveLoginUser({ identity, profile, primaryKind: primaryAuthKind() });
  try {
    return {
      id: row.id,
      username: row.username,
      role: await reconcileTrustedLoginRole({
        userId: row.id,
        providerRole: role,
        authRolesInitializedAt: row.authRolesInitializedAt,
        bootstrapIdentities,
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
      samlIdentity(result.user.rawClaims ?? {}, provider.saml.idpIssuer, result.user.username),
      {
        username: result.user.username,
        displayName: result.user.displayName,
        email: result.user.email,
      },
      role,
      // Only what the signed assertion states as-is (`samlAssertedIdentities`).
      samlAssertedIdentities(result.user.rawClaims ?? {}),
    );
    const permissions = getPermissionsForRole(userRow.role);
    const tokens = issueTokens({
      userId: userRow.id,
      username: userRow.username,
      role: userRow.role,
      permissions,
      workspaces: await readWorkspaceIds(userRow.id),
    });

    setBrowserSession(res, tokens);

    audit({
      actor: { id: userRow.id },
      action: "user.login",
      target: { type: "user", id: userRow.id },
      metadata: {
        username: userRow.username,
        role: userRow.role,
        mode: "saml",
        mfaPassed: result.user.mfaPassed,
      },
    });

    res.redirect(ssoLandingUrl());
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
      oidcIdentity(result.user.rawClaims ?? {}),
      {
        username: result.user.username,
        displayName: result.user.displayName,
        email: result.user.email,
      },
      role,
      // OIDC bootstraps on the verified `email` claim only (`oidcAssertedIdentities`).
      oidcAssertedIdentities(result.user.rawClaims ?? {}),
    );
    const permissions = getPermissionsForRole(userRow.role);
    const tokens = issueTokens({
      userId: userRow.id,
      username: userRow.username,
      role: userRow.role,
      permissions,
      workspaces: await readWorkspaceIds(userRow.id),
    });

    setBrowserSession(res, tokens);

    audit({
      actor: { id: userRow.id },
      action: "user.login",
      target: { type: "user", id: userRow.id },
      metadata: {
        username: userRow.username,
        role: userRow.role,
        mode: "oidc",
        mfaPassed: result.user.mfaPassed,
      },
    });

    res.redirect(ssoLandingUrl());
  });

  return r;
}
