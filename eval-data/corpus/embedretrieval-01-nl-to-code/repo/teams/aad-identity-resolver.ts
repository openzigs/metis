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
 * SECURITY — tenant-scoped, no cross-tenant leakage:
 *   - The binding key is `(tenantId, aadObjectId)` (unique). An `aadObjectId`
 *     from a DIFFERENT tenant can never collide with a local user's binding, so
 *     a foreign-tenant sender resolves to `null`.
 *   - `resolveUserFromAadObjectId` REQUIRES a non-empty `tenantId`; a missing
 *     tenant resolves to `null` (we never match a tenant-less sender).
 *   - An unbound sender resolves to `null` — callers in later phases (#551
 *     inbound) MUST treat `null` as "unmapped/unknown sender" and reject or flag
 *     it, never silently attribute the message to a METIS user.
 */
import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";

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
   * Resolve a Teams sender to a METIS user by `(tenantId, aadObjectId)`.
   *
   * Returns `null` (never throws, never guesses) when:
   *   - `tenantId` or `aadObjectId` is missing/blank (a tenant-less sender),
   *   - no binding exists for the pair (unmapped sender), OR
   *   - the bound user has since been soft-deleted/disabled.
   *
   * Because the lookup is keyed by tenant, an `aadObjectId` presented under a
   * DIFFERENT `tenantId` will not match — the cross-tenant isolation boundary.
   */
  async resolveUserFromAadObjectId(
    tenantId: string | null | undefined,
    aadObjectId: string | null | undefined,
  ): Promise<ResolvedMetisUser | null> {
    const tid = (tenantId ?? "").trim();
    const oid = (aadObjectId ?? "").trim();
    if (!tid || !oid) return null;

    const binding = await this.db.teamsUserIdentity.findUnique({
      where: { tenantId_aadObjectId: { tenantId: tid, aadObjectId: oid } },
      include: { user: true },
    });
    if (!binding) return null;

    const user = binding.user;
    // Defence-in-depth: a binding to a removed/disabled user must not resolve.
    if (!user || user.deletedAt !== null || user.status !== "active") return null;

    return { userId: user.id, username: user.username, email: user.email };
  }

  /**
   * Bind `(tenantId, aadObjectId)` to a METIS user, REUSING the existing SSO
   * email linkage: the AAD user's email is matched against `User.email` (the same
   * key `linkOnFirstSSOLogin` uses). On a match the binding is upserted; on no
   * match nothing is persisted and `{ ok: false, reason: "no_matching_user" }` is
   * returned so the caller can flag the sender as external.
   *
   * Idempotent: re-binding the same `(tenantId, aadObjectId)` updates the stored
   * `userId`/`email`/`workspaceId` in place (the SSO email may now resolve to a
   * different/renamed user).
   */
  async linkByEmail(params: {
    workspaceId: string;
    tenantId: string;
    aadObjectId: string;
    email: string;
  }): Promise<LinkOutcome> {
    const tenantId = params.tenantId.trim();
    const aadObjectId = params.aadObjectId.trim();
    const email = params.email.trim().toLowerCase();
    if (!tenantId || !aadObjectId || !email) {
      return { ok: false, reason: "no_matching_user" };
    }

    // Reuse the SSO identity-by-email match (case-insensitive). `User.email` is
    // stored as provided at create time; compare normalized to avoid case drift.
    const user = await this.db.user.findFirst({
      where: { email: { equals: email }, deletedAt: null, status: "active" },
      select: { id: true, email: true },
    });
    if (!user) {
      // Case-insensitive fallback for IdPs that emit a differently-cased UPN.
      const all = await this.db.user.findMany({
        where: { deletedAt: null, status: "active" },
        select: { id: true, email: true },
      });
      const ci = all.find((u) => u.email.toLowerCase() === email);
      if (!ci) {
        log.info("AAD email did not match any METIS user — sender left unmapped", {
          workspaceId: params.workspaceId,
          tenantId,
        });
        return { ok: false, reason: "no_matching_user" };
      }
      return this.upsertBinding(params.workspaceId, tenantId, aadObjectId, ci.id, ci.email);
    }

    return this.upsertBinding(params.workspaceId, tenantId, aadObjectId, user.id, user.email);
  }

  /**
   * Bind `(tenantId, aadObjectId)` to an explicit METIS user id (admin linking
   * path, when an email match is not desired/available). Validates the user is
   * active. Idempotent upsert on the `(tenantId, aadObjectId)` key.
   */
  async linkExplicit(params: {
    workspaceId: string;
    tenantId: string;
    aadObjectId: string;
    userId: string;
  }): Promise<LinkOutcome> {
    const tenantId = params.tenantId.trim();
    const aadObjectId = params.aadObjectId.trim();
    if (!tenantId || !aadObjectId || !params.userId) {
      return { ok: false, reason: "no_matching_user" };
    }
    const user = await this.db.user.findFirst({
      where: { id: params.userId, deletedAt: null, status: "active" },
      select: { id: true, email: true },
    });
    if (!user) return { ok: false, reason: "no_matching_user" };
    return this.upsertBinding(params.workspaceId, tenantId, aadObjectId, user.id, user.email);
  }

  /** Remove a binding (e.g. when a user leaves). Idempotent. */
  async unlink(tenantId: string, aadObjectId: string): Promise<boolean> {
    const res = await this.db.teamsUserIdentity.deleteMany({
      where: { tenantId: tenantId.trim(), aadObjectId: aadObjectId.trim() },
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
      where: { tenantId_aadObjectId: { tenantId, aadObjectId } },
      create: { workspaceId, tenantId, aadObjectId, userId, email },
      update: { workspaceId, userId, email },
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
 * phases: `resolveUserFromAadObjectId(tenantId, aadObjectId)`. Delegates to the
 * shared singleton resolver.
 */
export function resolveUserFromAadObjectId(
  tenantId: string | null | undefined,
  aadObjectId: string | null | undefined,
): Promise<ResolvedMetisUser | null> {
  return getTeamsAadIdentityResolver().resolveUserFromAadObjectId(tenantId, aadObjectId);
}
