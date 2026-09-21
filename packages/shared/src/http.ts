/**
 * HTTP/API contract shapes shared between server and UI.
 *
 * These types live in `@metis/shared` so the UI bundle never imports anything
 * server-side. JWTs are stringly-typed by JOSE; we keep the payload shape here.
 */
import type { PermissionKey, RoleKey } from "./constants.js";

/**
 * Decoded JWT access-token payload attached to authenticated requests.
 */
export interface AuthPayload {
  /** Stable user id (cuid) — comes from the User row. */
  userId: string;
  username: string;
  role: RoleKey;
  /** Permissions snapshot — denormalized at login for cheap middleware checks. */
  permissions: readonly PermissionKey[];
  /** Epic #759 — workspace IDs the user belongs to. */
  workspaces?: string[];
  /** How the user authenticated (mock, ldap, saml, oidc). */
  authMode?: string;
  /** Whether MFA was confirmed via SSO amr/AuthnContext claims. */
  mfaPassed?: boolean;
  iat?: number;
  exp?: number;
}

/**
 * Generic JSON envelope returned by every API endpoint.
 */
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  /** Echo of the inbound `X-Correlation-Id` header — useful for log correlation. */
  correlationId?: string;
}

/**
 * `/api/health` and `/healthz` payload — cheap liveness check.
 */
export interface HealthCheck {
  status: "ok";
  uptime: number;
  version: string;
  timestamp: string;
}

/**
 * `/api/health/deep` and `/readyz` payload — exercises external dependencies.
 */
export interface DeepHealthCheck extends Omit<HealthCheck, "status"> {
  status: "ok" | "degraded" | "error";
  checks: Record<
    string,
    {
      status: "ok" | "degraded" | "error";
      latencyMs?: number;
      message?: string;
    }
  >;
}
