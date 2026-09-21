/**
 * Issue #579 (epic #63) — Slack → METIS user identity resolver.
 *
 * A Slack interaction carries `team.id` + `user.id`, but not reliably an email.
 * METIS SSO maps an external identity to a `User` BY EMAIL (the same key
 * `linkOnFirstSSOLogin` uses, and the OIDC/SAML providers extract from claims).
 * So we do NOT invent a parallel identity system: we persist a durable
 * `(slackTeamId, slackUserId)→User` binding ESTABLISHED THROUGH that same email
 * match (or explicit admin linking), then resolve future senders against it.
 * This mirrors the #549 Teams AAD resolver exactly, swapping AAD keys for Slack.
 *
 * SECURITY — team-scoped, no cross-team leakage:
 *   - The binding key is `(slackTeamId, slackUserId)` (unique). A `slackUserId`
 *     from a DIFFERENT team can never collide with a local user's binding, so a
 *     foreign-team sender resolves to `null`.
 *   - `resolveUserFromSlackId` REQUIRES a non-empty `slackTeamId`; a missing team
 *     resolves to `null` (we never match a team-less sender).
 *   - An unbound sender resolves to `null` — callers (the ChatOps handlers) MUST
 *     treat `null` as "unmapped/unknown sender" and refuse, never silently
 *     attribute the action to a METIS user.
 */
import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";

const log = createChildLogger("slack-identity");

/** The resolved METIS user (minimal projection — callers fetch more if needed). */
export interface ResolvedMetisUser {
  userId: string;
  username: string;
  email: string;
}

/** Outcome of a link attempt — distinguishes the SSO-match miss from success. */
export type LinkOutcome = { ok: true; userId: string } | { ok: false; reason: "no_matching_user" };

export class SlackIdentityResolver {
  private readonly db: PrismaClient;

  constructor(db: PrismaClient = defaultPrisma) {
    this.db = db;
  }

  /**
   * Resolve a Slack sender to a METIS user by `(slackTeamId, slackUserId)`.
   *
   * Returns `null` (never throws, never guesses) when:
   *   - `slackTeamId` or `slackUserId` is missing/blank,
   *   - no binding exists for the pair (unmapped sender), OR
   *   - the bound user has since been soft-deleted/disabled.
   */
  async resolveUserFromSlackId(
    slackTeamId: string | null | undefined,
    slackUserId: string | null | undefined,
  ): Promise<ResolvedMetisUser | null> {
    const tid = (slackTeamId ?? "").trim();
    const uid = (slackUserId ?? "").trim();
    if (!tid || !uid) return null;

    const binding = await this.db.slackUserIdentity.findUnique({
      where: { slackTeamId_slackUserId: { slackTeamId: tid, slackUserId: uid } },
      include: { user: true },
    });
    if (!binding) return null;

    const user = binding.user;
    // Defence-in-depth: a binding to a removed/disabled user must not resolve.
    if (!user || user.deletedAt !== null || user.status !== "active") return null;

    return { userId: user.id, username: user.username, email: user.email };
  }

  /**
   * Bind `(slackTeamId, slackUserId)` to a METIS user, REUSING the existing SSO
   * email linkage: the Slack user's email is matched against `User.email`. On a
   * match the binding is upserted; on no match nothing is persisted and
   * `{ ok: false, reason: "no_matching_user" }` is returned so the caller can flag
   * the sender as external. Idempotent on the `(slackTeamId, slackUserId)` key.
   */
  async linkByEmail(params: {
    workspaceId: string;
    slackTeamId: string;
    slackUserId: string;
    email: string;
  }): Promise<LinkOutcome> {
    const slackTeamId = params.slackTeamId.trim();
    const slackUserId = params.slackUserId.trim();
    const email = params.email.trim().toLowerCase();
    if (!slackTeamId || !slackUserId || !email) {
      return { ok: false, reason: "no_matching_user" };
    }

    // Reuse the SSO identity-by-email match (case-insensitive).
    const user = await this.db.user.findFirst({
      where: { email: { equals: email }, deletedAt: null, status: "active" },
      select: { id: true, email: true },
    });
    if (!user) {
      // Case-insensitive fallback for IdPs/Slack profiles with differently-cased email.
      const all = await this.db.user.findMany({
        where: { deletedAt: null, status: "active" },
        select: { id: true, email: true },
      });
      const ci = all.find((u) => u.email.toLowerCase() === email);
      if (!ci) {
        log.info("Slack email did not match any METIS user — sender left unmapped", {
          workspaceId: params.workspaceId,
          slackTeamId,
        });
        return { ok: false, reason: "no_matching_user" };
      }
      return this.upsertBinding(params.workspaceId, slackTeamId, slackUserId, ci.id, ci.email);
    }

    return this.upsertBinding(params.workspaceId, slackTeamId, slackUserId, user.id, user.email);
  }

  /**
   * Bind `(slackTeamId, slackUserId)` to an explicit METIS user id (admin linking
   * path). Validates the user is active. Idempotent upsert on the key.
   */
  async linkExplicit(params: {
    workspaceId: string;
    slackTeamId: string;
    slackUserId: string;
    userId: string;
  }): Promise<LinkOutcome> {
    const slackTeamId = params.slackTeamId.trim();
    const slackUserId = params.slackUserId.trim();
    if (!slackTeamId || !slackUserId || !params.userId) {
      return { ok: false, reason: "no_matching_user" };
    }
    const user = await this.db.user.findFirst({
      where: { id: params.userId, deletedAt: null, status: "active" },
      select: { id: true, email: true },
    });
    if (!user) return { ok: false, reason: "no_matching_user" };
    return this.upsertBinding(params.workspaceId, slackTeamId, slackUserId, user.id, user.email);
  }

  /** Remove a binding (e.g. when a user leaves). Idempotent. */
  async unlink(slackTeamId: string, slackUserId: string): Promise<boolean> {
    const res = await this.db.slackUserIdentity.deleteMany({
      where: { slackTeamId: slackTeamId.trim(), slackUserId: slackUserId.trim() },
    });
    return res.count > 0;
  }

  private async upsertBinding(
    workspaceId: string,
    slackTeamId: string,
    slackUserId: string,
    userId: string,
    email: string | null,
  ): Promise<LinkOutcome> {
    await this.db.slackUserIdentity.upsert({
      where: { slackTeamId_slackUserId: { slackTeamId, slackUserId } },
      create: { workspaceId, slackTeamId, slackUserId, userId, email },
      update: { workspaceId, userId, email },
    });
    return { ok: true, userId };
  }
}

let singleton: SlackIdentityResolver | null = null;
export function getSlackIdentityResolver(): SlackIdentityResolver {
  if (!singleton) singleton = new SlackIdentityResolver();
  return singleton;
}

/** Test helper — reset the singleton so a test can inject its own Prisma. */
export function __resetSlackIdentityResolver(): void {
  singleton = null;
}
