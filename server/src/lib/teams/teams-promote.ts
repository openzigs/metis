/**
 * Epic #547 (Phase 3, #553) — PROMOTE a discussion message to a Requirement
 * directly from Microsoft Teams.
 *
 * MECHANISM (chosen + justified):
 *   Each mirrored message (#550) now carries an Adaptive Card with a
 *   "Promote to requirement" `Action.Submit` button (see
 *   `outbound-render.ts#renderMirroredMessageActivity`). Pressing it delivers a
 *   normal Bot Framework `message` activity whose `value` is the card action's
 *   `data` echoed back verbatim — `{ metisAction: "promote", threadId,
 *   messageId }`. The functional turn handler (#548 `runFoundationTurn`) already
 *   processes `message` activities, so no new invoke plumbing is needed.
 *
 *   We deliberately use `Action.Submit` (not `Action.Execute`): an `Action.Execute`
 *   produces an `adaptiveCard/action` INVOKE activity that botbuilder-js does not
 *   reliably dispatch unless the turn logic subclasses `TeamsActivityHandler`
 *   (this bot uses a plain functional turn callback). Submit also means the
 *   `DiscussionMessage` correlation needs NO new schema — the source ids ride in
 *   the action payload, which Teams returns untouched on click.
 *
 * FLOW (on a promote submit):
 *   1. CORRELATE — read `{ threadId, messageId }` from `activity.value`. A submit
 *      missing either id is a graceful error (`bad-correlation`).
 *   2. RESOLVE — the acting user via the #549 AAD→METIS resolver
 *      (`resolveUserFromAadObjectId(tenantId, aadObjectId)`), tenant-scoped. An
 *      unmapped/anonymous sender is REFUSED — never promote on behalf of nobody.
 *   3. AUTHORIZE — `canAccessThread` at the LOWEST privilege (`role: "reader"`),
 *      so access must be earned through real project membership, never a
 *      fabricated admin role (same posture as inbound #551).
 *   4. VERIFY the correlated message still exists in the thread (defence in depth
 *      — the card payload is untrusted client input).
 *   5. PROMOTE — call the EXISTING `promoteMessageToRequirement` (`promote.ts`),
 *      which creates the `Requirement` + `RequirementVersion` + `AuditLog`
 *      provenance attributed to the REAL resolved user. We do NOT reimplement
 *      promotion.
 *   6. RESPOND — a confirmation card on success; a clear refusal/error card on
 *      every failure. Internal error detail is NEVER leaked to the channel.
 *
 * SECURITY: the submit `value` is UNTRUSTED client input. We treat `threadId`/
 * `messageId` as opaque identifiers only — they flow into parameterized Prisma
 * lookups and the authorization check, never into an executable sink. Identity is
 * resolved tenant-scoped; authorization is independent of identity. A failed
 * promote is atomic in `promote.ts` (a `$transaction`), so a thrown error leaves
 * no partial Requirement.
 *
 * NON-THROWING: the handler returns an outcome for every branch and never throws
 * into the turn — a card-send failure is logged and swallowed.
 */
import type { Activity, TurnContext } from "botbuilder";
import type { PrismaClient } from "@prisma/client";

import { createChildLogger } from "../logger.js";
import { prisma as defaultPrisma } from "../prisma.js";
import { canAccessThread } from "../discussions/access.js";
import { promoteMessageToRequirement, PromoteError } from "../discussions/promote.js";
import {
  getTeamsAadIdentityResolver,
  type TeamsAadIdentityResolver,
} from "./aad-identity-resolver.js";
import { PROMOTE_ACTION } from "./outbound-render.js";
import {
  loadTeamsTenantAllowlist,
  isTeamsTenantAllowed,
  type TeamsTenantPolicy,
} from "./tenant-allowlist.js";

const log = createChildLogger("teams-promote");

const ADAPTIVE_CARD_CONTENT_TYPE = "application/vnd.microsoft.card.adaptive";

/** Why a promote submit did (or did not) result in a Requirement — for tests + logs. */
export type PromoteOutcome =
  | "promoted" // Requirement created; confirmation card posted
  | "bad-correlation" // submit value lacked threadId/messageId
  | "tenant-not-allowed" // activity's tenant is not on the configured allowlist
  | "unmapped-sender" // sender has no METIS identity binding
  | "forbidden" // resolved user may not access the thread
  | "thread-not-found" // thread missing/soft-deleted
  | "message-not-found" // correlated message not in the thread
  | "promote-failed"; // promote.ts threw (no partial state)

export interface PromoteHandlerResult {
  outcome: PromoteOutcome;
  requirementId?: string;
}

/** Injectable collaborators (defaults wire the real singletons). */
export interface PromoteHandlerDeps {
  workspaceId: string;
  resolver: TeamsAadIdentityResolver;
  /** Authorize the resolved user for the thread. Defaults to `canAccessThread`. */
  authorize: typeof canAccessThread;
  /** Create the Requirement. Defaults to the shared `promoteMessageToRequirement`. */
  promote: typeof promoteMessageToRequirement;
  /** Prisma client — only used to load the source message body for the title. */
  db: PrismaClient;
  /** Tenant allowlist policy (#554). Defaults to the env-configured policy. */
  tenantPolicy: TeamsTenantPolicy;
}

export interface PromoteHandlerOptions {
  workspaceId: string;
  resolver?: TeamsAadIdentityResolver;
  authorize?: typeof canAccessThread;
  promote?: typeof promoteMessageToRequirement;
  db?: PrismaClient;
  tenantPolicy?: TeamsTenantPolicy;
}

function resolveDeps(opts: PromoteHandlerOptions | PromoteHandlerDeps): PromoteHandlerDeps {
  const o = opts as PromoteHandlerOptions;
  return {
    workspaceId: o.workspaceId,
    resolver: o.resolver ?? getTeamsAadIdentityResolver(),
    authorize: o.authorize ?? canAccessThread,
    promote: o.promote ?? promoteMessageToRequirement,
    db: o.db ?? defaultPrisma,
    tenantPolicy: o.tenantPolicy ?? loadTeamsTenantAllowlist(),
  };
}

/** The shape of a promote submit's `activity.value` (untrusted client input). */
interface PromoteSubmitValue {
  metisAction?: unknown;
  threadId?: unknown;
  messageId?: unknown;
}

/**
 * Is this activity the "Promote to requirement" Action.Submit? A submit arrives
 * as a `message` activity whose `value.metisAction === "promote"`.
 */
export function isPromoteSubmit(activity: Partial<Activity> | undefined | null): boolean {
  if (!activity || activity.type !== "message") return false;
  const value = activity.value as PromoteSubmitValue | undefined;
  return !!value && value.metisAction === PROMOTE_ACTION;
}

/** Extract the AAD tenant id from the activity (channelData first, then conversation). */
function tenantIdOf(activity: Partial<Activity>): string | null {
  const fromChannelData = (activity.channelData as { tenant?: { id?: string } } | undefined)?.tenant
    ?.id;
  if (fromChannelData) return fromChannelData;
  const fromConversation = (activity.conversation as { tenantId?: string } | undefined)?.tenantId;
  return fromConversation ?? null;
}

/**
 * Derive a Requirement title from the source message body. The REST promote
 * endpoint requires a `title`; from Teams the button carries no free-text input,
 * so we derive a sensible default: the first non-empty line, clamped to 255 (the
 * column limit `promote.ts` also enforces). A blank body falls back to a neutral
 * label so a Requirement always gets a non-empty title.
 */
export function deriveTitleFromBody(body: string): string {
  const firstLine = (body ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  const title = (firstLine ?? "").slice(0, 255).trim();
  return title || "Requirement promoted from Teams";
}

// ── Card rendering (pure) ───────────────────────────────────────────────────

function card(body: Array<Record<string, unknown>>): Partial<Activity> {
  return {
    type: "message",
    attachments: [
      {
        contentType: ADAPTIVE_CARD_CONTENT_TYPE,
        content: {
          type: "AdaptiveCard",
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          version: "1.4",
          body,
        },
      },
    ],
  };
}

/** Confirmation card — Requirement created (id surfaced for traceability). */
export function buildConfirmationCard(requirementId: string): Partial<Activity> {
  return card([
    { type: "TextBlock", text: "✅ Requirement created", weight: "Bolder", wrap: true },
    {
      type: "TextBlock",
      text: `Promoted this message to requirement \`${requirementId}\`.`,
      wrap: true,
    },
  ]);
}

/** A clear refusal/error card. `detail` is always a safe, user-facing string. */
export function buildErrorCard(detail: string): Partial<Activity> {
  return card([
    { type: "TextBlock", text: "⚠️ Could not promote", weight: "Bolder", wrap: true },
    { type: "TextBlock", text: detail, wrap: true },
  ]);
}

/** Best-effort card send — never throws into the turn. */
async function safeSend(context: TurnContext, activity: Partial<Activity>): Promise<void> {
  try {
    await context.sendActivity(activity);
  } catch (err) {
    log.warn("Failed to post promote response card to Teams", {
      message: (err as Error).message,
    });
  }
}

/**
 * Handle a "Promote to requirement" Action.Submit from Teams. See the module doc
 * for the flow + security posture. NON-THROWING — returns an outcome for every
 * branch.
 */
export async function handleTeamsPromoteSubmit(
  context: TurnContext,
  opts: PromoteHandlerOptions | PromoteHandlerDeps,
): Promise<PromoteHandlerResult> {
  const deps = resolveDeps(opts);
  const activity = context.activity;
  const value = (activity.value ?? {}) as PromoteSubmitValue;

  // 1. CORRELATE — the source ids ride in the (untrusted) submit value.
  const threadId = typeof value.threadId === "string" ? value.threadId : "";
  const messageId = typeof value.messageId === "string" ? value.messageId : "";
  if (!threadId || !messageId) {
    await safeSend(
      context,
      buildErrorCard(
        "This action is missing the message reference. Try again from a recent message.",
      ),
    );
    return { outcome: "bad-correlation" };
  }

  // 1b. TENANT ALLOWLIST (#554, OWASP A01). A promote arrives as a `message`
  // activity that already passed the Bot Framework JWT (#548), but — exactly as
  // the inbound ingest path — we additionally pin the action to the operator's
  // approved tenant(s). A non-allowlisted tenant is refused before we resolve the
  // acting user. Under the empty/allow-all default this is a no-op.
  const tenantId = tenantIdOf(activity);
  if (!isTeamsTenantAllowed(deps.tenantPolicy, tenantId)) {
    log.warn("Teams promote rejected: tenant not on allowlist", {
      workspaceId: deps.workspaceId,
      threadId,
    });
    await safeSend(
      context,
      buildErrorCard("This Teams tenant isn't permitted to promote messages in METIS."),
    );
    return { outcome: "tenant-not-allowed" };
  }

  // 2. RESOLVE the acting user (tenant-scoped). Never promote on behalf of nobody.
  const aadObjectId = activity.from?.aadObjectId ?? null;
  const acting = await deps.resolver.resolveUserFromAadObjectId(tenantId, aadObjectId);
  if (!acting) {
    await safeSend(
      context,
      buildErrorCard(
        "Your Teams account isn't linked to a METIS user, so you can't promote messages. Ask a workspace admin to link your account.",
      ),
    );
    return { outcome: "unmapped-sender" };
  }

  // 3. AUTHORIZE at the lowest privilege — access must be earned, not fabricated.
  const access = await deps.authorize({ id: acting.userId, role: "reader" }, threadId);
  if (!access.ok) {
    if (access.reason === "not_found") {
      await safeSend(context, buildErrorCard("That discussion no longer exists."));
      return { outcome: "thread-not-found" };
    }
    await safeSend(
      context,
      buildErrorCard(
        "You don't have access to this discussion, so you can't promote its messages.",
      ),
    );
    return { outcome: "forbidden" };
  }

  // 4. VERIFY the correlated message exists in the thread (untrusted ids).
  const message = await deps.db.discussionMessage.findFirst({
    where: { id: messageId, threadId, deletedAt: null },
    select: { id: true, body: true },
  });
  if (!message) {
    await safeSend(context, buildErrorCard("That message could not be found in the discussion."));
    return { outcome: "message-not-found" };
  }

  // 5. PROMOTE via the EXISTING path — attributed to the REAL resolved user.
  try {
    const result = await deps.promote({
      actor: { id: acting.userId, role: "reader" },
      threadId,
      messageId,
      title: deriveTitleFromBody(message.body),
    });
    log.info("Promoted Teams message to requirement", {
      workspaceId: deps.workspaceId,
      threadId,
      messageId,
      requirementId: result.requirementId,
      actorId: acting.userId,
    });
    await safeSend(context, buildConfirmationCard(result.requirementId));
    return { outcome: "promoted", requirementId: result.requirementId };
  } catch (err) {
    // promote.ts is atomic (a $transaction) — a throw leaves no partial state.
    // We surface a SAFE message; internal detail is logged, never sent.
    const detail =
      err instanceof PromoteError
        ? "We couldn't promote this message. Please try again."
        : "Something went wrong promoting this message. Please try again.";
    log.warn("Promote-from-Teams failed", {
      workspaceId: deps.workspaceId,
      threadId,
      messageId,
      code: err instanceof PromoteError ? err.code : "UNKNOWN",
      message: (err as Error).message,
    });
    await safeSend(context, buildErrorCard(detail));
    return { outcome: "promote-failed" };
  }
}
