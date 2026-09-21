/**
 * Epic #547 (Phase 2, #550) — OUTBOUND message sync (METIS → Teams).
 *
 * When a new `DiscussionMessage` is created in a thread that is LINKED to a Teams
 * channel (#549 `TeamsChannelLink`), mirror it into that channel via a Bot
 * Framework PROACTIVE message, using the stored `ConversationReference` (#548).
 *
 * DESIGN GUARANTEES
 *
 * 1. BEST-EFFORT / NON-BLOCKING. The mirror runs OFF the request path. The
 *    route calls {@link mirrorMessageToTeams} fire-and-forget (no `await`); this
 *    function NEVER throws into its caller. An expired reference, a Teams API
 *    error, or an uninstalled app is logged and swallowed — the user's in-app
 *    POST that created the message always succeeds regardless. (Same posture as
 *    the existing `socket-emitter`/mention fan-out.)
 *
 * 2. ZERO-OVERHEAD WHEN UNLINKED. The very first thing we do is look up a link
 *    for the thread. No link → immediate no-op, no credential resolution, no
 *    adapter construction, no network. Most threads are not bridged, so the hot
 *    path stays free.
 *
 * 3. LOOP GUARD (critical). A message whose `origin` is `teams` came IN from the
 *    linked channel (inbound sync #551). Mirroring it back OUT would echo it into
 *    the same channel it arrived from — an infinite loop. We skip any non-`metis`
 *    origin BEFORE any work. #551 sets `origin: "teams"` on ingest; this is the
 *    seam it relies on.
 *
 * 4. PROACTIVE SEND. We resolve the workspace's bot credentials (#548 vault),
 *    build a `CloudAdapter`, and call `continueConversationAsync(botAppId, ref,
 *    logic)` — the CloudAdapter proactive API in botbuilder 4.23.3 (the legacy
 *    `continueConversation(ref, logic)` is unsupported on CloudAdapter). The
 *    `logic` callback sends the rendered activity.
 *
 * Every collaborator is injectable so the orchestration can be unit-tested with
 * stubs — no live Azure tenant, no real Prisma, no real network.
 */
import type { PrismaClient } from "@prisma/client";
import type { ConversationReference, TurnContext } from "botbuilder";

import { prisma as defaultPrisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";
import { getBotAdapterFactory, type BotAdapterFactory } from "./bot-adapter.js";
import {
  getTeamsInstallationStore,
  type ResolvedCredentials,
  type TeamsInstallationStore,
} from "./installation-store.js";
import {
  getTeamsChannelLinkStore,
  type ChannelLinkSummary,
  type TeamsChannelLinkStore,
} from "./channel-link-store.js";
import {
  getConversationReferenceStore,
  type ConversationReferenceStore,
  type StoredConversationReference,
} from "./conversation-reference-store.js";
import { renderTeamsMessage, renderMirroredMessageActivity } from "./outbound-render.js";

const log = createChildLogger("teams-outbound");

/** Origin discriminator for the loop guard. */
export const MESSAGE_ORIGIN_METIS = "metis";
export const MESSAGE_ORIGIN_TEAMS = "teams";

/** The message fields outbound sync needs. Mirrors the persisted row subset. */
export interface OutboundMessage {
  id: string;
  threadId: string;
  authorKind: string;
  authorUserId?: string | null;
  aiModel?: string | null;
  body: string;
  /** `metis` | `teams` — the loop-guard discriminator (#550). */
  origin?: string | null;
}

/** Minimal adapter surface we need for a proactive send. */
export interface ProactiveAdapterLike {
  continueConversationAsync(
    botAppId: string,
    reference: Partial<ConversationReference>,
    logic: (context: TurnContext) => Promise<void>,
  ): Promise<void>;
}

/** Injectable collaborators (defaults wire the real singletons/factories). */
export interface OutboundSyncDeps {
  db: PrismaClient;
  linkStore: TeamsChannelLinkStore;
  refStore: ConversationReferenceStore;
  installStore: TeamsInstallationStore;
  adapterFactory: BotAdapterFactory;
}

function defaultDeps(): OutboundSyncDeps {
  return {
    db: defaultPrisma,
    linkStore: getTeamsChannelLinkStore(),
    refStore: getConversationReferenceStore(),
    installStore: getTeamsInstallationStore(),
    adapterFactory: getBotAdapterFactory(),
  };
}

/**
 * Resolve the Teams channel link for a thread WITHOUT the caller knowing the
 * workspace. The link store is workspace-scoped, but a thread is globally unique
 * and belongs to exactly one project → one workspace. We derive the workspace
 * from the thread's project, then read the link. Returns null when the thread
 * has no project (deleted) or no link.
 */
async function resolveLinkForThread(
  db: PrismaClient,
  linkStore: TeamsChannelLinkStore,
  threadId: string,
): Promise<ChannelLinkSummary | null> {
  const thread = await db.discussionThread.findFirst({
    where: { id: threadId, deletedAt: null },
    select: { project: { select: { workspaceId: true } } },
  });
  const workspaceId = thread?.project?.workspaceId;
  if (!workspaceId) return null;
  return linkStore.getByThread(workspaceId, threadId);
}

/** Resolve a human author's display name (best-effort; null when not found). */
async function resolveDisplayName(
  db: PrismaClient,
  authorUserId: string | null | undefined,
): Promise<string | null> {
  if (!authorUserId) return null;
  const user = await db.user.findUnique({
    where: { id: authorUserId },
    select: { displayName: true },
  });
  return user?.displayName ?? null;
}

/**
 * Send a single proactive activity into the linked channel. Encapsulates
 * credential resolution + adapter construction + the `continueConversationAsync`
 * call. Throws on any failure (the orchestrator swallows it).
 */
async function sendProactive(
  deps: OutboundSyncDeps,
  link: ChannelLinkSummary,
  stored: StoredConversationReference,
  text: string,
  threadId: string,
  messageId: string,
): Promise<void> {
  const creds: ResolvedCredentials | null = await deps.installStore.resolveAppPassword(
    link.workspaceId,
  );
  if (!creds) {
    // No active installation → cannot authenticate a proactive send.
    throw new Error(`no active Teams installation for workspace ${link.workspaceId}`);
  }

  const adapter = deps.adapterFactory(creds) as unknown as ProactiveAdapterLike;
  if (typeof adapter.continueConversationAsync !== "function") {
    throw new Error("adapter does not support continueConversationAsync (proactive send)");
  }

  // #553: mirror the message as an actionable Adaptive Card carrying a
  // "Promote to requirement" button. The `text` fallback keeps non-card clients
  // readable; the card's Action.Submit data correlates the click back to this
  // source DiscussionMessage (no new schema).
  const activity = renderMirroredMessageActivity({ text, threadId, messageId });

  await adapter.continueConversationAsync(creds.appId, stored.reference, async (context) => {
    await context.sendActivity(activity);
  });
}

/**
 * Mirror a newly-created `DiscussionMessage` to its linked Teams channel, if
 * any. BEST-EFFORT and NON-THROWING — designed to be called fire-and-forget
 * from the message-creation path. Returns a small result object describing what
 * happened (useful for tests and structured logs); never rejects.
 */
export async function mirrorMessageToTeams(
  threadId: string,
  message: OutboundMessage,
  overrides: Partial<OutboundSyncDeps> = {},
): Promise<{ mirrored: boolean; reason?: string }> {
  const deps: OutboundSyncDeps = { ...defaultDeps(), ...overrides };

  try {
    // 3. LOOP GUARD — never mirror a Teams-originated message back out.
    const origin = message.origin ?? MESSAGE_ORIGIN_METIS;
    if (origin !== MESSAGE_ORIGIN_METIS) {
      return { mirrored: false, reason: "teams-origin" };
    }

    // 2. ZERO-OVERHEAD WHEN UNLINKED — bail before any credential/network work.
    const link = await resolveLinkForThread(deps.db, deps.linkStore, threadId);
    if (!link) {
      return { mirrored: false, reason: "no-link" };
    }
    if (link.status !== "active") {
      return { mirrored: false, reason: "link-inactive" };
    }

    // Need a stored ConversationReference to send proactively (#548).
    const stored = await deps.refStore.get(link.workspaceId, link.conversationId);
    if (!stored) {
      return { mirrored: false, reason: "no-reference" };
    }

    // Render authorship distinctly (human vs AI).
    const displayName = await resolveDisplayName(deps.db, message.authorUserId);
    const text = renderTeamsMessage(
      { authorKind: message.authorKind, displayName, aiModel: message.aiModel },
      message.body,
    );

    // 4. PROACTIVE SEND (as an actionable Adaptive Card — #553).
    await sendProactive(deps, link, stored, text, threadId, message.id);
    return { mirrored: true };
  } catch (err) {
    // 1. BEST-EFFORT — swallow + log. The in-app message creation is unaffected.
    log.warn("outbound Teams mirror failed", {
      threadId,
      messageId: message.id,
      error: (err as Error).message,
    });
    return { mirrored: false, reason: "error" };
  }
}

/**
 * Fire-and-forget wrapper for the request path. Schedules the mirror and returns
 * immediately; any rejection (there should be none — {@link mirrorMessageToTeams}
 * never rejects) is caught so an unhandled promise rejection can never surface.
 */
export function scheduleMirrorToTeams(threadId: string, message: OutboundMessage): void {
  void mirrorMessageToTeams(threadId, message).catch((err) => {
    log.warn("outbound Teams mirror scheduling error", {
      threadId,
      messageId: message.id,
      error: (err as Error).message,
    });
  });
}
