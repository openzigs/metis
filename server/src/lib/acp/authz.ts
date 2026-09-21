/**
 * ACP authorization bridge — Issue #676 (Epic #671, OWASP A01 BOLA/BFLA).
 *
 * The ACP WebSocket transport authenticates callers with a per-user bearer
 * token (`VerifiedToken` = `{ tokenId, userId, scopes }`) but that payload
 * carries neither the caller's role nor their workspace memberships. The
 * canonical tenant-authz helpers used by the REST twin
 * (`POST /api/custom-agents/:id/invoke` → `assertProjectAccess`) operate on an
 * `AuthPayload` (`role` + `workspaces`).
 *
 * This module bridges `VerifiedToken` → `AuthPayload` (loading role + workspace
 * memberships exactly the way the login path does in `routes/auth.ts`) so the
 * SAME helpers can gate the ACP handlers, and it defines the ACP method →
 * token-scope mapping enforced in `dispatchAcp` (BFLA).
 *
 * Tenant scoping uses the workspace-membership model (parity with
 * `assertProjectAccess`): a project is visible when it has no workspace
 * (pre-migration / open) OR its workspace is one the caller belongs to; admins
 * see everything.
 */
import type { AuthPayload, RoleKey } from "@metis/shared";
import { prisma } from "../prisma.js";
import { workspaceScopeWhere } from "../auth/project-scope.js";
import type { VerifiedToken } from "./api-tokens.js";

// ---- Token scopes (BFLA — method-level authorization) ----------------------

/** Canonical ACP token scopes. Read = list-*; Run = run-agent. */
export const ACP_SCOPES = {
  READ: "acp:read",
  RUN: "acp:run",
} as const;

/** Wildcard scope that grants every ACP method. */
export const ACP_SCOPE_WILDCARD = "acp:*";

/** Scopes a minting user may be granted. No admin-only method exists today, so
 * this set is identical for every role — the per-tenant authz at call time is
 * what actually bounds a token's reach. */
export const GRANTABLE_ACP_SCOPES: readonly string[] = [ACP_SCOPES.READ, ACP_SCOPES.RUN];

/** Which token scope each ACP method requires. */
export const ACP_METHOD_SCOPES: Readonly<Record<string, string>> = {
  "list-projects": ACP_SCOPES.READ,
  "list-skills": ACP_SCOPES.READ,
  "list-agents": ACP_SCOPES.READ,
  "run-agent": ACP_SCOPES.RUN,
};

/** True when `scopes` grant `required` (directly or via the `acp:*` wildcard). */
export function tokenHasScope(scopes: readonly string[], required: string): boolean {
  return scopes.includes(ACP_SCOPE_WILDCARD) || scopes.includes(required);
}

/**
 * Clamp the scopes requested at token-mint to what the user may actually be
 * granted. Unknown / over-privileged scopes are dropped (never minted) so a
 * token can never carry more authority than the platform recognizes. When no
 * scopes are requested (or everything requested is dropped) we default to the
 * full grantable set for ergonomics — each method is still tenant-authorized at
 * call time.
 *
 * A requested `acp:*` wildcard is EXPANDED into the concrete grantable set
 * rather than persisted verbatim: the stored token lists explicit scopes and
 * never carries `acp:*`. This preserves the caller's evident intent (full
 * self-service access) while closing a latent BFLA foot-gun — were an
 * admin-only ACP method added later, a persisted wildcard would auto-grant it
 * to every pre-existing user-minted token. Dispatch still honors `acp:*` on
 * already-issued tokens (`tokenHasScope`) for backward-compat.
 */
export function clampAcpScopes(requested: readonly string[] | undefined): string[] {
  if (!requested || requested.length === 0) return [...GRANTABLE_ACP_SCOPES];
  const grantable = new Set<string>(GRANTABLE_ACP_SCOPES);
  const clamped = new Set<string>();
  for (const scope of requested) {
    if (scope === ACP_SCOPE_WILDCARD) {
      for (const granted of GRANTABLE_ACP_SCOPES) clamped.add(granted);
      continue;
    }
    if (grantable.has(scope)) clamped.add(scope);
  }
  if (clamped.size === 0) return [...GRANTABLE_ACP_SCOPES];
  return [...clamped];
}

// ---- Actor resolution (VerifiedToken → AuthPayload) ------------------------

/**
 * Resolve the ACP token's user into the `AuthPayload` shape the canonical
 * tenant-authz helpers expect. Mirrors `ensureUserRow` + the workspace lookup
 * in `routes/auth.ts`: role comes from the user's assigned `UserRole` (falling
 * back to the least-privileged `reader` when none is assigned, so an unassigned
 * token never gains admin bypass), and workspaces from `WorkspaceMember`.
 */
export async function resolveAcpActor(auth: VerifiedToken): Promise<AuthPayload> {
  const [userRole, memberships] = await Promise.all([
    prisma.userRole.findFirst({
      where: { userId: auth.userId },
      include: { role: true },
    }),
    prisma.workspaceMember.findMany({
      where: { userId: auth.userId },
      select: { workspaceId: true },
    }),
  ]);
  const role = (userRole?.role.key as RoleKey | undefined) ?? "reader";
  return {
    userId: auth.userId,
    username: "",
    role,
    // Permissions are not consulted by any ACP tenant check (role + workspaces
    // are what `assertProjectAccess` reads); keep the payload minimal.
    permissions: [],
    workspaces: memberships.map((m) => m.workspaceId),
  };
}

export function isAdminActor(actor: AuthPayload): boolean {
  return actor.role === "admin";
}

// ---- Project scoping (workspace-membership model) --------------------------

/**
 * Prisma `where` for `prisma.project` matching every project the actor may
 * see: the canonical workspace-visibility rule (`workspaceScopeWhere`, see
 * `lib/auth/project-scope.ts`) plus a `deletedAt: null` guard. Admins see all
 * non-deleted projects; everyone else sees workspace-less (open) projects plus
 * projects whose workspace they belong to — the same rules as
 * `assertProjectAccess`.
 *
 * Reach for this when you want a project `where`. If you need the bare
 * workspace predicate to merge into a query over some other model, use
 * `workspaceScopeWhere` directly — this helper lives in an ACP-named module
 * for historical reasons only (Issue #1066), it is not ACP-specific.
 */
export function accessibleProjectWhere(actor: AuthPayload): Record<string, unknown> {
  return { deletedAt: null, ...workspaceScopeWhere(actor) };
}

/** The concrete list of project ids the actor may access. */
export async function listAccessibleProjectIds(actor: AuthPayload): Promise<string[]> {
  const rows = await prisma.project.findMany({
    where: accessibleProjectWhere(actor),
    select: { id: true },
  });
  return rows.map((r) => r.id);
}
