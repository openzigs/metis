/**
 * #1564 — what an authorization middleware enforces, stamped on the handler it
 * returns. The MFA route walk (`tests/require-mfa-routes-1554.sqlite.test.ts`)
 * reads it to key the MFA gate on the permission a route requires, not on its
 * URL prefix, and to check the gate runs after authorization.
 */
import type { RequestHandler } from "express";

export interface AuthorizationRequirement {
  kind: "permission" | "role" | "workspaceRole";
  value: string;
}

const AUTHORIZATION = Symbol.for("metis.authorization");

/** Stamp `handler` with the requirement it enforces, and return it. */
export function tagAuthorization(
  handler: RequestHandler,
  requirement: AuthorizationRequirement,
): RequestHandler {
  Object.defineProperty(handler, AUTHORIZATION, { value: requirement });
  return handler;
}

/** The requirement `handler` enforces, or `undefined` for any other handler. */
export function authorizationOf(handler: unknown): AuthorizationRequirement | undefined {
  if (typeof handler !== "function") return undefined;
  return (handler as unknown as Record<symbol, AuthorizationRequirement | undefined>)[
    AUTHORIZATION
  ];
}
