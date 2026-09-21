/**
 * `requireAuth` — extracts the access token from `Authorization: Bearer ...`
 * or the `accessToken` cookie, verifies it, and attaches the decoded payload
 * to `req.user`. Distinguishes between missing/expired/malformed tokens with
 * specific error codes.
 */
import type { RequestHandler } from "express";
import jwt from "jsonwebtoken";
import { getPermissionsForRole, type RoleKey } from "@metis/shared";
import { resolveEffectiveRole } from "../lib/auth/durable-roles.js";
import { verifyAccessToken } from "../lib/auth/jwt.js";
import { prisma } from "../lib/prisma.js";
import { AppError } from "./error-handler.js";

function isRecognizedRole(role: string | undefined): role is RoleKey {
  return role === "admin" || role === "coordinator" || role === "developer" || role === "reader";
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  try {
    const auth = req.headers.authorization;
    let token: string | undefined;
    if (auth?.startsWith("Bearer ")) {
      token = auth.slice("Bearer ".length).trim();
    }
    if (!token) {
      const cookies = (req as unknown as { cookies?: Record<string, string> }).cookies;
      token = cookies?.accessToken;
    }
    if (!token) {
      throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
    }

    try {
      req.user = verifyAccessToken(token);
      next();
    } catch (err) {
      if (err instanceof jwt.TokenExpiredError) {
        throw new AppError(401, "TOKEN_EXPIRED", "Access token has expired");
      }
      // Any other verification failure — malformed/tampered JWT, or a token that
      // verifies but is the wrong KIND (e.g. a refresh token presented as an
      // access token, which `verifyAccessToken` rejects with a plain Error) — is
      // an authentication failure, NOT a server error or an authorization
      // denial. Normalize it to a stable 401 TOKEN_INVALID so it stays
      // refresh-eligible client-side and never degrades to a 500. The raw cause
      // stays in server logs only (OWASP A01/A09 — no detail leak to the client).
      throw new AppError(401, "TOKEN_INVALID", "Access token is malformed or invalid");
    }
  } catch (err) {
    next(err);
  }
};

/**
 * Refresh `req.user` from durable auth state so route authorization never trusts
 * stale JWT role/workspace claims after role revocation or account disablement.
 */
export const refreshAuthenticatedUser: RequestHandler = async (req, _res, next) => {
  try {
    if (!req.user?.userId) {
      throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
    }
    const [user, memberships, role] = await Promise.all([
      prisma.user.findFirst({
        where: { id: req.user.userId, status: "active", deletedAt: null },
        select: { id: true, username: true, authRolesInitializedAt: true },
      }),
      prisma.workspaceMember.findMany({
        where: { userId: req.user.userId },
        select: { workspaceId: true },
      }),
      resolveEffectiveRole(req.user.userId),
    ]);
    if (!user) {
      throw new AppError(401, "TOKEN_INVALID", "Access token is malformed or invalid");
    }
    req.user = {
      userId: user.id,
      username: user.username,
      role: isRecognizedRole(role.role) ? role.role : "reader",
      permissions: getPermissionsForRole(isRecognizedRole(role.role) ? role.role : "reader"),
      workspaces: memberships.map((membership) => membership.workspaceId),
    };
    next();
  } catch (err) {
    next(err);
  }
};
