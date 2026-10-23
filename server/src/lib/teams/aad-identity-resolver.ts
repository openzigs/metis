/**
 * Epic #547 (Phase 1, #549) — AAD → METIS user identity resolver.
 *
 * A Teams inbound activity (and the #548 stored ConversationReference) carries a
 * sender's `aadObjectId` + `tenantId`, but NOT reliably an email. METIS SSO
 * (OIDC/SAML) maps an external identity to a `User` BY EMAIL
 * (`server/src/lib/auth/migrate-link-sso.ts` `linkOnFirstSSOLogin`, and the
 * OIDC/SAML providers extract `email` from claims). So we do NOT invent a
 * parallel identity system: we persist a durable `(tenantId, aadObjectId)→User`
 * binding that is ESTABLISHED THROUGH that same email match (or explicit admin
 * linking), then resolve future senders against it.
 *
 * SECURITY — tenant- and workspace-scoped (#1431), no cross-tenant leakage:
 *   - A binding belongs to ONE workspace and may only name an active member of
 *     it (`../workspaces/chatops-identity-scope.ts`); it resolves only for that
 *     workspace's bot, and only while the user is still a member.
 *   - The binding key is `(workspaceId, tenantId, aadObjectId)` (unique). An
 *     `aadObjectId` from a DIFFERENT tenant can never collide with a local
 *     user's binding, so a foreign-tenant sender resolves to `null`; another
 *     workspace's link of the same person is a different row, never overwritten.
 *   - `resolveUserFromAadObjectId` REQUIRES a non-empty `tenantId`; a missing
 *     tenant resolves to `null` (we never match a tenant-less sender).
 *   - An unbound sender resolves to `null` — callers in later phases (#551
 *     inbound) MUST treat `null` as "unmapped/unknown sender" and reject or flag
 *     it, never silently attribute the message to a METIS user.
 */
import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";
import {
  findBindableWorkspaceUser,
  isActiveWorkspaceMember,
} from "../workspaces/chatops-identity-scope.js";

const log = createChildLogger("teams-aad-identity");

/** The resolved METIS user (minimal projection — callers fetch more if needed). */
export interface ResolvedMetisUser {
  userId: string;
  username: string;
  email: string;
}

/** Outcome of a link attempt — distinguishes the SSO-match miss from success. */
export type LinkOutcome = { ok: true; userId: string } | { ok: false; reason: "no_matching_user" };

export class TeamsAadIdentityResolver {
  private readonly db: PrismaClient;

  constructor(db: PrismaClient = defaultPrisma) {
    this.db = db;
  }

  /**
   * Resolve a Teams sender to a METIS user by `(workspaceId, tenantId,
   * aadObjectId)`, where `workspaceId` is the workspace whose bot received the
   * activity.
   *
   * Returns `null` (never throws, never guesses) when:
   *   - any of the three is missing/blank (a tenant-less sender),
   *   - this workspace has no binding for the pair (unmapped sender — another
   *     workspace's binding of the same person never resolves here, #1431),
   *   - the bound user has since been soft-deleted/disabled, OR
   *   - the bound user is no longer an active member of the workspace (#1431:
   *     this also refuses a binding the pre-fix route wrote naming a non-member).
   *
   * Because the lookup is keyed by tenant, an `aadObjectId` presented under a
   * DIFFERENT `tenantId` will not match — the cross-tenant isolation boundary.
   */
  async resolveUserFromAadObjectId(
    tenantId: string | null | undefined,
    aadObjectId: string | null | undefined,
    workspaceId: string,
  ): Promise<ResolvedMetisUser | null> {
    const tid = (tenantId ?? "").trim();
    const oid = (aadObjectId ?? "").trim();
    const ws = (workspaceId ?? "").trim();
    if (!tid || !oid || !ws) return null;

    const binding = await this.db.teamsUserIdentity.findUnique({
      where: {
        workspaceId_tenantId_aadObjectId: { workspaceId: ws, tenantId: tid, aadObjectId: oid },
      },
      include: { user: true },
    });
    if (!binding) return null;

    const user = binding.user;
    // Defence-in-depth: a binding to a removed/disabled user must not resolve.
    if (!user || user.deletedAt !== null || user.status !== "active") return null;
    if (!(await isActiveWorkspaceMember(this.db, ws, user.id))) {
      log.warn("AAD binding names a user outside the bot's workspace — refused", {
        workspaceId: ws,
      });
      return null;
    }

    return { userId: user.id, username: user.username, email: user.email };
  }

  /**
   * Bind `(tenantId, aadObjectId)` in `workspaceId` to a METIS user, REUSING the
   * existing SSO email linkage: the AAD user's email is matched
   * (case-insensitively) against the `User.email` of the workspace's MEMBERS
   * only (#1431). On a match the binding is upserted; on no match nothing is
   * persisted and `{ ok: false, reason: "no_matching_user" }` is returned — the
   * same answer whether the email is unknown or belongs to a non-member.
   *
   * Idempotent: re-binding the same `(workspaceId, tenantId, aadObjectId)`
   * updates that workspace's stored `userId`/`email` in place. Another
   * workspace's binding of the same identity is a different row, never touched.
   */
  async linkByEmail(params: {
    workspaceId: string;
    tenantId: string;
    aadObjectId: string;
    email: string;
    /** Only a system-admin caller may bind a member who is a system admin. */
    allowSystemAdminTarget?: boolean;
  }): Promise<LinkOutcome> {
    const tenantId = params.tenantId.trim();
    const aadObjectId = params.aadObjectId.trim();
    const email = params.email.trim().toLowerCase();
    if (!tenantId || !aadObjectId || !email) {
      return { ok: false, reason: "no_matching_user" };
    }
    const user = await findBindableWorkspaceUser(this.db, {
      workspaceId: params.workspaceId,
      email,
      allowSystemAdminTarget: params.allowSystemAdminTarget,
    });
    if (!user) {
      log.info("AAD email matched no bindable workspace member — sender left unmapped", {
        workspaceId: params.workspaceId,
        tenantId,
      });
      return { ok: false, reason: "no_matching_user" };
    }
    return this.upsertBinding(params.workspaceId, tenantId, aadObjectId, user.id, user.email);
  }

  /**
   * Bind `(tenantId, aadObjectId)` in `workspaceId` to an explicit METIS user id
   * (admin linking path, when an email match is not desired/available). The user
   * must be an active member of `workspaceId` (#1431) — a system admin only when
   * `allowSystemAdminTarget`. Idempotent upsert on the workspace-scoped key.
   */
  async linkExplicit(params: {
    workspaceId: string;
    tenantId: string;
    aadObjectId: string;
    userId: string;
    /** Only a system-admin caller may bind a member who is a system admin. */
    allowSystemAdminTarget?: boolean;
  }): Promise<LinkOutcome> {
    const tenantId = params.tenantId.trim();
    const aadObjectId = params.aadObjectId.trim();
    if (!tenantId || !aadObjectId || !params.userId) {
      return { ok: false, reason: "no_matching_user" };
    }
    const user = await findBindableWorkspaceUser(this.db, {
      workspaceId: params.workspaceId,
      userId: params.userId,
      allowSystemAdminTarget: params.allowSystemAdminTarget,
    });
    if (!user) return { ok: false, reason: "no_matching_user" };
    return this.upsertBinding(params.workspaceId, tenantId, aadObjectId, user.id, user.email);
  }

  /**
   * Remove `workspaceId`'s binding of `(tenantId, aadObjectId)` (e.g. when a user
   * leaves). Never touches another workspace's binding. Idempotent.
   */
  async unlink(workspaceId: string, tenantId: string, aadObjectId: string): Promise<boolean> {
    const res = await this.db.teamsUserIdentity.deleteMany({
      where: {
        workspaceId: workspaceId.trim(),
        tenantId: tenantId.trim(),
        aadObjectId: aadObjectId.trim(),
      },
    });
    return res.count > 0;
  }

  private async upsertBinding(
    workspaceId: string,
    tenantId: string,
    aadObjectId: string,
    userId: string,
    email: string | null,
  ): Promise<LinkOutcome> {
    await this.db.teamsUserIdentity.upsert({
      where: { workspaceId_tenantId_aadObjectId: { workspaceId, tenantId, aadObjectId } },
      create: { workspaceId, tenantId, aadObjectId, userId, email },
      update: { userId, email },
    });
    return { ok: true, userId };
  }
}

let singleton: TeamsAadIdentityResolver | null = null;
export function getTeamsAadIdentityResolver(): TeamsAadIdentityResolver {
  if (!singleton) singleton = new TeamsAadIdentityResolver();
  return singleton;
}

/** Test helper — reset the singleton so a test can inject its own Prisma. */
export function __resetTeamsAadIdentityResolver(): void {
  singleton = null;
}

/**
 * Convenience free function matching the signature the epic specifies for later
 * phases — `resolveUserFromAadObjectId(tenantId, aadObjectId)` — plus the bot's
 * `workspaceId` (#1431). Delegates to the shared singleton resolver.
 */
export function resolveUserFromAadObjectId(
  tenantId: string | null | undefined,
  aadObjectId: string | null | undefined,
  workspaceId: string,
): Promise<ResolvedMetisUser | null> {
  return getTeamsAadIdentityResolver().resolveUserFromAadObjectId(
    tenantId,
    aadObjectId,
    workspaceId,
  );
}
