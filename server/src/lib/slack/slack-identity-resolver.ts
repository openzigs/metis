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
 * SECURITY — team- and workspace-scoped (#1431), no cross-team leakage:
 *   - A binding belongs to ONE workspace and may only name an active member of
 *     it (`../workspaces/chatops-identity-scope.ts`); it resolves only for that
 *     workspace's Slack install, and only while the user is still a member.
 *   - The binding key is `(workspaceId, slackTeamId, slackUserId)` (unique). A
 *     `slackUserId` from a DIFFERENT team can never collide with a local user's
 *     binding, so a foreign-team sender resolves to `null`; another workspace's
 *     link of the same person is a different row, never overwritten.
 *   - `resolveUserFromSlackId` REQUIRES a non-empty `slackTeamId`; a missing team
 *     resolves to `null` (we never match a team-less sender).
 *   - An unbound sender resolves to `null` — callers (the ChatOps handlers) MUST
 *     treat `null` as "unmapped/unknown sender" and refuse, never silently
 *     attribute the action to a METIS user.
 */
import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";
import {
  findBindableWorkspaceUser,
  isActiveWorkspaceMember,
} from "../workspaces/chatops-identity-scope.js";

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
   * Resolve a Slack sender to a METIS user by `(workspaceId, slackTeamId,
   * slackUserId)`, where `workspaceId` owns the Slack install the request came
   * through.
   *
   * Returns `null` (never throws, never guesses) when:
   *   - any of the three is missing/blank,
   *   - this workspace has no binding for the pair (unmapped sender),
   *   - the bound user has since been soft-deleted/disabled, OR
   *   - the bound user is no longer an active member of the workspace (#1431).
   */
  async resolveUserFromSlackId(
    slackTeamId: string | null | undefined,
    slackUserId: string | null | undefined,
    workspaceId: string,
  ): Promise<ResolvedMetisUser | null> {
    const tid = (slackTeamId ?? "").trim();
    const uid = (slackUserId ?? "").trim();
    const ws = (workspaceId ?? "").trim();
    if (!tid || !uid || !ws) return null;

    const binding = await this.db.slackUserIdentity.findUnique({
      where: {
        workspaceId_slackTeamId_slackUserId: {
          workspaceId: ws,
          slackTeamId: tid,
          slackUserId: uid,
        },
      },
      include: { user: true },
    });
    if (!binding) return null;

    const user = binding.user;
    // Defence-in-depth: a binding to a removed/disabled user must not resolve.
    if (!user || user.deletedAt !== null || user.status !== "active") return null;
    if (!(await isActiveWorkspaceMember(this.db, ws, user.id))) {
      log.warn("Slack binding names a user outside the install's workspace — refused", {
        workspaceId: ws,
      });
      return null;
    }

    return { userId: user.id, username: user.username, email: user.email };
  }

  /**
   * Bind `(slackTeamId, slackUserId)` in `workspaceId` to a METIS user, REUSING
   * the existing SSO email linkage: the Slack user's email is matched
   * (case-insensitively) against the `User.email` of the workspace's MEMBERS only
   * (#1431). On a match the binding is upserted; on no match nothing is
   * persisted and `{ ok: false, reason: "no_matching_user" }` is returned — the
   * same answer whether the email is unknown or belongs to a non-member.
   * Idempotent on the workspace-scoped key.
   */
  async linkByEmail(params: {
    workspaceId: string;
    slackTeamId: string;
    slackUserId: string;
    email: string;
    /** Only a system-admin caller may bind a member who is a system admin. */
    allowSystemAdminTarget?: boolean;
  }): Promise<LinkOutcome> {
    const slackTeamId = params.slackTeamId.trim();
    const slackUserId = params.slackUserId.trim();
    // Case as typed: the scope helper folds case only to filter candidates.
    const email = params.email.trim();
    if (!slackTeamId || !slackUserId || !email) {
      return { ok: false, reason: "no_matching_user" };
    }
    const user = await findBindableWorkspaceUser(this.db, {
      workspaceId: params.workspaceId,
      email,
      allowSystemAdminTarget: params.allowSystemAdminTarget,
    });
    if (!user) {
      log.info("Slack email matched no bindable workspace member — sender left unmapped", {
        workspaceId: params.workspaceId,
        slackTeamId,
      });
      return { ok: false, reason: "no_matching_user" };
    }
    return this.upsertBinding(params.workspaceId, slackTeamId, slackUserId, user.id, user.email);
  }

  /**
   * Bind `(slackTeamId, slackUserId)` in `workspaceId` to an explicit METIS user
   * id (admin linking path). The user must be an active member of `workspaceId`
   * (#1431) — a system admin only when `allowSystemAdminTarget`. Idempotent
   * upsert on the workspace-scoped key.
   */
  async linkExplicit(params: {
    workspaceId: string;
    slackTeamId: string;
    slackUserId: string;
    userId: string;
    /** Only a system-admin caller may bind a member who is a system admin. */
    allowSystemAdminTarget?: boolean;
  }): Promise<LinkOutcome> {
    const slackTeamId = params.slackTeamId.trim();
    const slackUserId = params.slackUserId.trim();
    if (!slackTeamId || !slackUserId || !params.userId) {
      return { ok: false, reason: "no_matching_user" };
    }
    const user = await findBindableWorkspaceUser(this.db, {
      workspaceId: params.workspaceId,
      userId: params.userId,
      allowSystemAdminTarget: params.allowSystemAdminTarget,
    });
    if (!user) return { ok: false, reason: "no_matching_user" };
    return this.upsertBinding(params.workspaceId, slackTeamId, slackUserId, user.id, user.email);
  }

  /**
   * Remove `workspaceId`'s binding of `(slackTeamId, slackUserId)` (e.g. when a
   * user leaves). Never touches another workspace's binding. Idempotent.
   */
  async unlink(workspaceId: string, slackTeamId: string, slackUserId: string): Promise<boolean> {
    const res = await this.db.slackUserIdentity.deleteMany({
      where: {
        workspaceId: workspaceId.trim(),
        slackTeamId: slackTeamId.trim(),
        slackUserId: slackUserId.trim(),
      },
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
      where: {
        workspaceId_slackTeamId_slackUserId: { workspaceId, slackTeamId, slackUserId },
      },
      create: { workspaceId, slackTeamId, slackUserId, userId, email },
      update: { userId, email },
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
