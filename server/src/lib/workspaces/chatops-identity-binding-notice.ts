/**
 * Issue #2089 — a chat identity binding is never silent.
 *
 * A binding (Teams AAD id today; the Slack resolver has no route yet) lets the
 * bound chat account run commands AS the bound member (#1431,
 * `chatops-identity-scope.ts`), and a workspace admin may bind to any member,
 * the owner included. The owner decided (2026-11-09) that this stays without an
 * MFA gate, and that every binding is instead:
 *
 *   - AUDITED: actor, workspace, provider, bound member and external id (no
 *     secrets: the external id is a directory object id, not a credential);
 *   - NOTIFIED in-app to the workspace OWNER, and to the bound member when they
 *     are not the actor. Recipients are deduplicated, so an owner binding their
 *     own chat account is told once.
 *
 * The notice is a security receipt, so it is NOT gated on notification
 * preferences: an owner who has muted in-app notifications must still learn
 * that someone can now act as them. Its type is project-less
 * (`PROJECTLESS_NOTIFICATION_TYPES`): it is about a person and a workspace, and
 * the recipient keeps seeing the record of who bound a chat account to them.
 *
 * Recipients come from the committed membership (the owner row) and from the
 * resolver's result (the bound user), never from request input.
 *
 * NON-THROWING: the binding is already written when this runs. A failed
 * notification is logged at error level and never fails the request; the audit
 * row is queued independently of it.
 */
import { prisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";
import { audit } from "../audit/audit-service.js";

const log = createChildLogger("chatops-identity-binding-notice");

/** `Notification.type` of the binding notice. Project-less (see header). */
export const CHAT_IDENTITY_BOUND_TYPE = "chat_identity_bound";

/** `AuditLog.action` of a binding. */
export const CHAT_IDENTITY_BIND_ACTION = "chatops.identity.bind";

/** Chat providers whose identities can be bound. */
export type ChatIdentityProvider = "teams" | "slack";

const PROVIDER_LABEL: Record<ChatIdentityProvider, string> = {
  teams: "Microsoft Teams",
  slack: "Slack",
};

export interface ChatIdentityBinding {
  /** The METIS user who made the binding (from the verified JWT). */
  actorId: string | null;
  workspaceId: string;
  provider: ChatIdentityProvider;
  /** The member the chat account now acts as (from the resolver's result). */
  boundUserId: string;
  /** Directory scope of the external id (Teams tenant, Slack team). */
  externalScope: string;
  /** The chat account's id (Teams AAD object id, Slack user id). */
  externalId: string;
}

/** A user's name as shown in a notice, falling back to a neutral label. */
function nameOf(u: { displayName: string; username: string } | null | undefined): string {
  return u?.displayName || u?.username || "A workspace admin";
}

/**
 * Audit and announce one binding. Resolves when the notices are persisted (or
 * have failed and been logged); never throws.
 */
export async function recordChatIdentityBinding(b: ChatIdentityBinding): Promise<void> {
  audit({
    actor: b.actorId,
    action: CHAT_IDENTITY_BIND_ACTION,
    target: { type: "user", id: b.boundUserId },
    metadata: {
      workspaceId: b.workspaceId,
      provider: b.provider,
      boundUserId: b.boundUserId,
      externalScope: b.externalScope,
      externalId: b.externalId,
    },
  });

  try {
    const [owner, workspace, people] = await Promise.all([
      prisma.workspaceMember.findFirst({
        where: { workspaceId: b.workspaceId, role: "owner" },
        select: { userId: true },
      }),
      prisma.workspace.findUnique({ where: { id: b.workspaceId }, select: { name: true } }),
      prisma.user.findMany({
        where: { id: { in: [b.boundUserId, ...(b.actorId ? [b.actorId] : [])] } },
        select: { id: true, displayName: true, username: true },
      }),
    ]);

    const recipients = new Set<string>();
    if (owner?.userId) recipients.add(owner.userId);
    if (b.boundUserId !== b.actorId) recipients.add(b.boundUserId);
    if (!owner?.userId) {
      log.error("Chat identity bound in a workspace with no owner row — owner not notified", {
        workspaceId: b.workspaceId,
      });
    }

    const byId = new Map(people.map((p) => [p.id, p]));
    const actor = b.actorId ? nameOf(byId.get(b.actorId)) : "A workspace admin";
    const bound = nameOf(byId.get(b.boundUserId));
    const provider = PROVIDER_LABEL[b.provider];
    const where = workspace?.name ? `the workspace "${workspace.name}"` : "a workspace";
    const payload = JSON.stringify({
      kind: CHAT_IDENTITY_BOUND_TYPE,
      workspaceId: b.workspaceId,
      provider: b.provider,
      boundUserId: b.boundUserId,
      actorId: b.actorId,
      externalId: b.externalId,
    });

    await Promise.all(
      [...recipients].map(async (userId) => {
        const toBound = userId === b.boundUserId;
        const title = toBound
          ? `A ${provider} account can now act as you`
          : `A ${provider} account can now act as ${bound}`;
        const message =
          `${actor} linked ${provider} account ${b.externalId} to ` +
          `${toBound ? "you" : bound} in ${where}. Chat commands from that account ` +
          `now run with ${toBound ? "your" : "their"} permissions in this workspace.`;
        try {
          await prisma.notification.create({
            data: {
              userId,
              type: "chat_identity_bound",
              title,
              message,
              href: null,
              payload,
              // #1447 — project-less by design: the type is opted in.
              projectId: null,
            },
          });
        } catch (err) {
          log.error("Failed to persist chat identity binding notice", {
            workspaceId: b.workspaceId,
            userId,
            error: (err as Error).message,
          });
        }
      }),
    );
  } catch (err) {
    log.error("Failed to announce chat identity binding", {
      workspaceId: b.workspaceId,
      error: (err as Error).message,
    });
  }
}
