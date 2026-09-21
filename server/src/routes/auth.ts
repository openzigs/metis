/**
 * /api/auth — login / logout / me / refresh.
 *
 * - Returns the access token in the JSON body AND sets HttpOnly cookies for
 *   browser clients.
 * - On successful login, persists or upserts the User row so foreign keys
 *   (audit, projects) resolve. The seed handles initial roles.
 * - Audit events are emitted for login success/failure and logout.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { CookieOptions } from "express";
import type { ApiResponse, RoleKey } from "@metis/shared";
import { getPermissionsForRole } from "@metis/shared";
import { getAuthProvider, type AuthenticatedUser } from "../lib/auth/providers.js";
import {
  issueTokens,
  refreshAccessToken,
  revokeRefreshToken,
  verifyRefreshToken,
} from "../lib/auth/jwt.js";
import { audit } from "../lib/audit/audit-service.js";
import { toAuthUser } from "../lib/auth/auth-user.js";
import { reconcileTrustedLoginRole } from "../lib/auth/durable-roles.js";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { AppError } from "../middleware/error-handler.js";

const loginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});

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

async function ensureUserRow(user: AuthenticatedUser): Promise<{ id: string; role: RoleKey }> {
  const row = await prisma.user.upsert({
    where: { username: user.username },
    update: {
      displayName: user.displayName,
      email: user.email,
      lastLoginAt: new Date(),
    },
    create: {
      username: user.username,
      displayName: user.displayName,
      email: user.email,
      status: "active",
      lastLoginAt: new Date(),
      authRolesInitializedAt: null,
    },
  });
  const role = await reconcileTrustedLoginRole({
    userId: row.id,
    providerRole: user.role,
    authRolesInitializedAt:
      (row as { authRolesInitializedAt?: Date | null }).authRolesInitializedAt ?? null,
  });
  return { id: row.id, role };
}

export function authRouter(): Router {
  const r = Router();

  r.post("/login", async (req: Request, res: Response) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "VALIDATION_ERROR", "Invalid login payload", {
        issues: parsed.error.errors,
      });
    }
    const { username, password } = parsed.data;
    const result = await getAuthProvider().authenticate(username, password);
    if (!result.success) {
      audit({
        actor: null,
        action: "user.login.failed",
        target: { type: "user", id: username },
        metadata: { reason: result.error },
      });
      throw new AppError(401, "AUTH_FAILED", result.error);
    }
    const userRow = await ensureUserRow(result.user);
    const permissions = getPermissionsForRole(userRow.role);
    const workspaces = await readWorkspaceIds(userRow.id);
    const tokens = issueTokens({
      userId: userRow.id,
      username: result.user.username,
      role: userRow.role,
      permissions,
      workspaces,
    });

    res.cookie("accessToken", tokens.accessToken, {
      ...cookieOptions(),
      maxAge: 60 * 60 * 1000,
    });
    res.cookie("refreshToken", tokens.refreshToken, {
      ...cookieOptions(),
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    audit({
      actor: { id: userRow.id },
      action: "user.login",
      target: { type: "user", id: userRow.id },
      metadata: { username: result.user.username, role: userRow.role },
    });

    const body: ApiResponse = {
      success: true,
      data: {
        user: toAuthUser(
          {
            userId: userRow.id,
            username: result.user.username,
            role: userRow.role,
            permissions,
          },
          { displayName: result.user.displayName, email: result.user.email },
        ),
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      },
    };
    res.json(body);
  });

  r.post("/logout", requireAuth, async (req: Request, res: Response) => {
    const cookies = (req as unknown as { cookies?: Record<string, string> }).cookies;
    const refreshToken = cookies?.refreshToken ?? (req.body?.refreshToken as string | undefined);
    if (refreshToken) {
      try {
        const decoded = await verifyRefreshToken(refreshToken);
        const expiresAt = decoded.exp !== undefined ? new Date(decoded.exp * 1000) : new Date();
        await revokeRefreshToken(decoded.tokenId, decoded.userId, expiresAt);
      } catch {
        /* Already invalid — nothing to revoke. */
      }
    }
    res.clearCookie("accessToken", cookieOptions());
    res.clearCookie("refreshToken", cookieOptions());
    audit({
      actor: { id: req.user?.userId ?? null },
      action: "user.logout",
      target: { type: "user", id: req.user?.userId ?? "unknown" },
    });
    const body: ApiResponse = { success: true, data: { message: "Logged out" } };
    res.json(body);
  });

  r.get("/me", requireAuth, async (req: Request, res: Response) => {
    // The access-token payload (`req.user`) intentionally omits displayName /
    // email to keep the JWT small and avoid stale claims when a user is
    // renamed. `/auth/me` is low-frequency, so we enrich it here with a single
    // indexed PK lookup against the User row (the same source login reads).
    let displayName: string | undefined;
    let email: string | undefined;
    if (req.user?.userId) {
      const row = await prisma.user.findUnique({
        where: { id: req.user.userId },
        select: { displayName: true, email: true },
      });
      if (row) {
        displayName = row.displayName;
        email = row.email;
      }
    }
    // Issue #642 — normalize to the shared client contract via `toAuthUser`, so
    // `/auth/me` returns `id` (mapped from the JWT `userId`) exactly like
    // `/auth/login`. Spreading `req.user` here would leak `userId` (and no `id`),
    // which the UI reads as `undefined` after a hard reload and silently drops
    // identity-gated affordances (e.g. the reviewer DecisionBar).
    const body: ApiResponse = {
      success: true,
      data: { user: toAuthUser(req.user!, { displayName, email }) },
    };
    res.json(body);
  });

  r.post("/refresh", async (req: Request, res: Response) => {
    const cookies = (req as unknown as { cookies?: Record<string, string> }).cookies;
    const refreshToken = cookies?.refreshToken ?? (req.body?.refreshToken as string | undefined);
    if (!refreshToken) {
      throw new AppError(401, "NO_REFRESH_TOKEN", "Refresh token is required");
    }
    let tokens;
    try {
      tokens = await refreshAccessToken(refreshToken);
    } catch {
      throw new AppError(401, "REFRESH_FAILED", "Invalid or expired refresh token");
    }
    res.cookie("accessToken", tokens.accessToken, {
      ...cookieOptions(),
      maxAge: 60 * 60 * 1000,
    });
    res.cookie("refreshToken", tokens.refreshToken, {
      ...cookieOptions(),
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    const body: ApiResponse = {
      success: true,
      data: { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken },
    };
    res.json(body);
  });

  return r;
}
