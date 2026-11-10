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
 * A REBIND (#2107) moves an existing binding from one member to another, which
 * silently took the chat account away from the first. The audit entry records
 * that member as `replacedUserId`, and they are told too (unless they made the
 * rebind themselves): their chat commands no longer run as them.
 *
 * The notice text names the external id and the workspace name, which the
 * admin it exposes can choose (any 1-200 characters for the id). Both are
 * quoted with their quotes and control characters escaped, and the id is cut
 * to a GUID's length, so that input cannot pass for the notice's own wording.
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
  /**
   * #2107 — the member a rebind took this chat account away from (from the
   * resolver's result); absent or null for a new binding.
   */
  replacedUserId?: string | null;
}

/**
 * Longest external id shown in full: a Teams AAD object id is a 36-character
 * GUID and a Slack user id is shorter. The audit entry keeps the full value.
 */
const MAX_EXTERNAL_ID_SHOWN = 40;
/** Longest workspace name shown in full (`routes/workspaces.ts` allows 100). */
const MAX_WORKSPACE_NAME_SHOWN = 100;

/**
 * `value` as a double-quoted string with its own quotes and control characters
 * escaped (JSON rules), cut at `max` characters with an ellipsis, so text a
 * user chose cannot close the quote and read as the notice's own sentence.
 */
function quoted(value: string, max: number): string {
  const chars = [...value];
  return JSON.stringify(chars.length > max ? `${chars.slice(0, max).join("")}…` : value);
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
  const replacedId = b.replacedUserId || null;
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
      ...(replacedId ? { replacedUserId: replacedId } : {}),
    },
  });

  try {
    // Every owner, not the first: a workspace can have co-owners, and the owner
    // decision on #2089 is that a binding is never silent to an owner.
    const [owners, workspace, people] = await Promise.all([
      prisma.workspaceMember.findMany({
        where: { workspaceId: b.workspaceId, role: "owner" },
        select: { userId: true },
      }),
      prisma.workspace.findUnique({ where: { id: b.workspaceId }, select: { name: true } }),
      prisma.user.findMany({
        where: {
          id: {
            in: [
              b.boundUserId,
              ...(b.actorId ? [b.actorId] : []),
              ...(replacedId ? [replacedId] : []),
            ],
          },
        },
        select: { id: true, displayName: true, username: true },
      }),
    ]);

    const recipients = new Set<string>();
    for (const o of owners) if (o.userId) recipients.add(o.userId);
    if (b.boundUserId !== b.actorId) recipients.add(b.boundUserId);
    if (replacedId && replacedId !== b.actorId) recipients.add(replacedId);
    if (owners.length === 0) {
      log.error("Chat identity bound in a workspace with no owner row — owner not notified", {
        workspaceId: b.workspaceId,
      });
    }

    const byId = new Map(people.map((p) => [p.id, p]));
    const actor = b.actorId ? nameOf(byId.get(b.actorId)) : "A workspace admin";
    const bound = nameOf(byId.get(b.boundUserId));
    const replaced = replacedId ? nameOf(byId.get(replacedId)) : null;
    const provider = PROVIDER_LABEL[b.provider];
    const account = `${provider} account ${quoted(b.externalId, MAX_EXTERNAL_ID_SHOWN)}`;
    const where = workspace?.name
      ? `the workspace ${quoted(workspace.name, MAX_WORKSPACE_NAME_SHOWN)}`
      : "a workspace";
    const payload = JSON.stringify({
      kind: CHAT_IDENTITY_BOUND_TYPE,
      workspaceId: b.workspaceId,
      provider: b.provider,
      boundUserId: b.boundUserId,
      actorId: b.actorId,
      externalId: b.externalId,
      ...(replacedId ? { replacedUserId: replacedId } : {}),
    });

    await Promise.all(
      [...recipients].map(async (userId) => {
        const toBound = userId === b.boundUserId;
        let title: string;
        let message: string;
        if (userId === replacedId) {
          title = `A ${provider} account no longer acts as you`;
          message =
            `${actor} linked ${account}, which acted as you, to ${bound} in ${where}. ` +
            `Chat commands from that account now run with ${bound}'s permissions, not yours.`;
        } else {
          title = toBound
            ? `A ${provider} account can now act as you`
            : `A ${provider} account can now act as ${bound}`;
          message =
            `${actor} linked ${account} to ${toBound ? "you" : bound} in ${where}. ` +
            `Chat commands from that account now run with ${toBound ? "your" : "their"} ` +
            `permissions in this workspace.` +
            (replaced ? ` It previously acted as ${replaced}.` : "");
        }
        try {
          await prisma.notification.create({
            data: {
              userId,
              // CHAT_IDENTITY_BOUND_TYPE, written as a literal on purpose: the
              // #1447 writer scan (tests/notification-writers-1447.test.ts)
              // reads `type` from the AST and rejects an unlisted identifier.
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
