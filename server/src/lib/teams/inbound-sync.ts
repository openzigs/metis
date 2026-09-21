/**
 * Epic #547 (Phase 2, #551) — INBOUND message sync (Teams → METIS).
 *
 * When a user posts a message in a Teams channel that is LINKED to a discussion
 * thread (#549), ingest it as a `DiscussionMessage` so it appears to in-app
 * users in realtime exactly like a native one.
 *
 * FLOW (on a Bot Framework `message` activity):
 *   1. IGNORE non-message activities and the bot's OWN activities (loop guard:
 *      the proactive messages #550 sends arrive back as activities whose
 *      `from.id === recipient.id` (the bot) — re-ingesting them would loop).
 *   2. Resolve the channel → thread LINK (#549 `getByConversation`). No link →
 *      ignore (the channel is not bridged).
 *   3. Resolve the SENDER via `(tenantId, aadObjectId) → METIS user` (#549). An
 *      unmapped sender resolves to `null` — we NEVER attribute a message to
 *      nobody: we skip ingestion and (once per sender, best-effort) post a hint
 *      back to the channel inviting them to link their METIS account.
 *   4. MEMBER/TENANT authorization — the resolved user must be able to access the
 *      target thread (`canAccessThread`). A resolved-but-unauthorized sender is
 *      rejected (defence in depth; identity ≠ authorization).
 *   5. Create the message via the SHARED `createHumanDiscussionMessage` with
 *      `origin="teams"` — same invariants, member fan-out, and realtime emit as
 *      the REST path; the `teams` origin makes #550 skip mirroring it back out.
 *   6. AI PARTICIPANT (#552). Read the thread's `aiResponseMode` and delegate to
 *      `maybeRespondAsAI`, which runs the SAME gate + responder the in-app path
 *      uses — an `@AI` mention triggers an AI reply that #550 mirrors back into
 *      the channel (exactly once). Best-effort: never changes the ingest outcome.
 *
 * LOOP-GUARD ROUND TRIP (end to end):
 *   - Teams → `origin=teams` DiscussionMessage → #550 skips it (not echoed back)
 *     → appears in-app. ✓
 *   - In-app → `origin=metis` → #550 mirrors out → arrives as a bot activity
 *     (`from.id === bot`) → step 1 ignores it (not re-ingested). ✓
 *
 * SECURITY: Teams message text is UNTRUSTED. We never execute it; it flows only
 * into `DiscussionMessage.body`, rendered by the existing XSS-safe markdown path.
 * The endpoint itself is already gated by Bot Framework JWT auth (#548).
 *
 * Every collaborator is injectable so the handler can be unit-tested with a fake
 * TurnContext + stub stores (no live Azure tenant, Prisma, or network).
 */
import { ActivityTypes, type Activity, type TurnContext } from "botbuilder";

import { createChildLogger } from "../logger.js";
import { getTeamsChannelLinkStore, type TeamsChannelLinkStore } from "./channel-link-store.js";
import {
  getTeamsAadIdentityResolver,
  type TeamsAadIdentityResolver,
  type ResolvedMetisUser,
} from "./aad-identity-resolver.js";
import { canAccessThread } from "../discussions/access.js";
import { createHumanDiscussionMessage } from "../discussions/create-message.js";
import { maybeRespondAsAI } from "./ai-participant.js";
import { prisma as defaultPrisma } from "../prisma.js";
import type { PrismaClient } from "@prisma/client";
import {
  loadTeamsTenantAllowlist,
  isTeamsTenantAllowed,
  type TeamsTenantPolicy,
} from "./tenant-allowlist.js";
import {
  checkInboundRateLimit,
  loadInboundRateLimitConfig,
  type InboundRateLimitConfig,
  type InboundRateLimitResult,
} from "./inbound-rate-limit.js";

const log = createChildLogger("teams-inbound");

/** Why an inbound activity was (or was not) ingested — for tests + structured logs. */
export type InboundOutcome =
  | "ingested"
  | "not-message" // non-message activity (e.g. conversationUpdate, typing)
  | "bot-own-message" // the bot's own/echoed activity — loop guard
  | "empty-text" // message with no usable text content
  | "no-link" // channel not bridged to a thread
  | "tenant-not-allowed" // activity's tenant is not on the configured allowlist
  | "rate-limited" // (workspace, conversation) inbound cap reached
  | "unmapped-sender" // sender has no METIS identity binding
  | "forbidden" // resolved user may not access the thread
  | "thread-not-found"; // link points at a missing/soft-deleted thread

export interface InboundResult {
  outcome: InboundOutcome;
  messageId?: string;
}

/** Injectable collaborators (defaults wire the real singletons). */
export interface InboundSyncDeps {
  workspaceId: string;
  linkStore: TeamsChannelLinkStore;
  identityResolver: TeamsAadIdentityResolver;
  /** Authorize the resolved user for the thread. Defaults to `canAccessThread`. */
  authorize: typeof canAccessThread;
  /** Create the human message + run the fan-out. Defaults to the shared helper. */
  createMessage: typeof createHumanDiscussionMessage;
  /**
   * AI participant (#552). After a human message is ingested, decide + (when
   * warranted) run the AI reply via the SAME gate/responder the REST path uses.
   * Defaults to {@link maybeRespondAsAI}; injectable for tests.
   */
  respondAsAI: typeof maybeRespondAsAI;
  /** Prisma client — only used to read the thread's `aiResponseMode` (#552). */
  db: PrismaClient;
  /** Tenant allowlist policy (#554). Defaults to the env-configured policy. */
  tenantPolicy: TeamsTenantPolicy;
  /** Per-(workspace, conversation) inbound cap config (#554). Defaults from env. */
  rateLimitConfig: InboundRateLimitConfig;
  /** Inbound rate-limit check (#554). Injectable for tests. */
  rateLimit: typeof checkInboundRateLimit;
}

export interface InboundSyncOptions {
  workspaceId: string;
  linkStore?: TeamsChannelLinkStore;
  identityResolver?: TeamsAadIdentityResolver;
  authorize?: typeof canAccessThread;
  createMessage?: typeof createHumanDiscussionMessage;
  respondAsAI?: typeof maybeRespondAsAI;
  db?: PrismaClient;
  tenantPolicy?: TeamsTenantPolicy;
  rateLimitConfig?: InboundRateLimitConfig;
  rateLimit?: typeof checkInboundRateLimit;
}

function resolveDeps(opts: InboundSyncOptions): InboundSyncDeps {
  return {
    workspaceId: opts.workspaceId,
    linkStore: opts.linkStore ?? getTeamsChannelLinkStore(),
    identityResolver: opts.identityResolver ?? getTeamsAadIdentityResolver(),
    authorize: opts.authorize ?? canAccessThread,
    createMessage: opts.createMessage ?? createHumanDiscussionMessage,
    respondAsAI: opts.respondAsAI ?? maybeRespondAsAI,
    db: opts.db ?? defaultPrisma,
    tenantPolicy: opts.tenantPolicy ?? loadTeamsTenantAllowlist(),
    rateLimitConfig: opts.rateLimitConfig ?? loadInboundRateLimitConfig(),
    rateLimit: opts.rateLimit ?? checkInboundRateLimit,
  };
}

/** Extract the AAD tenant id from a Teams activity (channelData first, then conversation). */
function tenantIdOf(activity: Partial<Activity>): string | null {
  const fromChannelData = (activity.channelData as { tenant?: { id?: string } } | undefined)?.tenant
    ?.id;
  if (fromChannelData) return fromChannelData;
  const fromConversation = (activity.conversation as { tenantId?: string } | undefined)?.tenantId;
  return fromConversation ?? null;
}

/**
 * Strip the leading bot @mention from inbound text. Teams prefixes channel
 * messages addressed to the bot with the bot's display name; we keep the human
 * body and drop that prefix so the persisted message reads naturally.
 */
function stripRecipientMention(context: TurnContext): string {
  const activity = context.activity;
  let text = (activity.text ?? "").trim();
  if (!text) return "";

  // Teams prefixes a channel message addressed to the bot with a mention entity
  // whose `mentioned.id === activity.recipient.id`; its `text` (e.g.
  // `<at>METIS</at>`) appears verbatim in `activity.text`. Remove ONLY those
  // recipient-targeted mention strings — other users' mentions are preserved so
  // the persisted body reads as the author wrote it. Deterministic + dependency-
  // free (we do not rely on SDK internals so behaviour is identical in tests and
  // production).
  const botId = activity.recipient?.id ?? "";
  const entities = (activity.entities ?? []) as Array<{
    type?: string;
    text?: string;
    mentioned?: { id?: string };
  }>;
  for (const ent of entities) {
    if (ent.type === "mention" && ent.text && ent.mentioned?.id && ent.mentioned.id === botId) {
      text = text.split(ent.text).join(" ");
    }
  }
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Ingest a single Bot Framework activity as a human `DiscussionMessage` when it
 * belongs to a linked, authorized conversation. NON-THROWING for the expected
 * "skip" cases (returns an outcome); only an unexpected store/db error
 * propagates (the turn-level handler logs + swallows it).
 */
export async function ingestTeamsActivity(
  context: TurnContext,
  opts: InboundSyncOptions,
): Promise<InboundResult> {
  const deps = resolveDeps(opts);
  const activity = context.activity;

  // 1a. Only message activities carry content to ingest.
  if (activity.type !== ActivityTypes.Message) {
    return { outcome: "not-message" };
  }

  // 1b. LOOP GUARD — ignore the bot's OWN activities. A proactive message #550
  // sent comes back with `from.id === recipient.id` (the bot's own id). Never
  // re-ingest it.
  const fromId = activity.from?.id ?? "";
  const botId = activity.recipient?.id ?? "";
  if (fromId && botId && fromId === botId) {
    return { outcome: "bot-own-message" };
  }

  // 2. Resolve the channel → thread link (workspace-scoped).
  const conversationId = activity.conversation?.id ?? "";
  if (!conversationId) return { outcome: "no-link" };
  const link = await deps.linkStore.getByConversation(deps.workspaceId, conversationId);
  if (!link || link.status !== "active") {
    return { outcome: "no-link" };
  }

  // Meaningful text required (a bare mention or an attachment-only post is skipped).
  const body = stripRecipientMention(context);
  if (!body) return { outcome: "empty-text" };

  // 2a. TENANT ALLOWLIST (#554, OWASP A01 — defence in depth). The Bot Framework
  // JWT (#548) proves the activity is genuinely from the channel service, but a
  // MultiTenant bot would otherwise accept a validly-signed activity from ANY
  // tenant. Pin the bridge to the operator's approved tenant(s). Tenant id source
  // matches the prior phases (channelData → conversation → link). Under an empty
  // allowlist this is allow-all (documented default); under a configured list a
  // non-allowlisted (or tenant-less) sender is rejected here — BEFORE we resolve a
  // sender, write a message, invoke the AI, or promote.
  const tenantId = tenantIdOf(activity) ?? link.tenantId;
  if (!isTeamsTenantAllowed(deps.tenantPolicy, tenantId)) {
    log.warn("Teams activity rejected: tenant not on allowlist", {
      workspaceId: deps.workspaceId,
      threadId: link.threadId,
    });
    return { outcome: "tenant-not-allowed" };
  }

  // 2b. INBOUND RATE LIMIT (#554, OWASP A04). Cap inbound activity per
  // (workspace, conversation) so a chatty/abusive channel cannot flood METIS with
  // DiscussionMessage writes + fan-out. Enforced AFTER the cheap link/tenant
  // gates (so unbridged/foreign traffic doesn't consume a real channel's budget)
  // but BEFORE the identity resolve + DB write. Best-effort: a limiter backend
  // failure must not break ingestion, so a store error fails OPEN (logged).
  let rl: InboundRateLimitResult | null = null;
  try {
    rl = await deps.rateLimit(
      { workspaceId: deps.workspaceId, conversationId },
      deps.rateLimitConfig,
    );
  } catch (err) {
    log.warn("Teams inbound rate-limit check failed (failing open)", {
      workspaceId: deps.workspaceId,
      message: (err as Error).message,
    });
  }
  if (rl && !rl.allowed) {
    log.info("Teams inbound activity rate-limited", {
      workspaceId: deps.workspaceId,
      threadId: link.threadId,
      limit: rl.limit,
      retryAfterMs: rl.retryAfterMs,
    });
    return { outcome: "rate-limited" };
  }

  // 3. Resolve the sender. Prefer the activity's own tenant id; fall back to the
  // link's recorded tenant. NEVER attribute to nobody.
  const aadObjectId = activity.from?.aadObjectId ?? null;
  const user: ResolvedMetisUser | null = await deps.identityResolver.resolveUserFromAadObjectId(
    tenantId,
    aadObjectId,
  );

  if (!user) {
    await postUnmappedHint(context, deps.workspaceId);
    return { outcome: "unmapped-sender" };
  }

  // 4. MEMBER/TENANT authorization — identity is not authorization. The resolved
  // user must be able to access the target thread. We pass the LOWEST-privilege
  // role ("reader") deliberately: a Teams sender must earn access through actual
  // project membership (`actorCanAccessProject`), never through a fabricated
  // global-admin role that would short-circuit the membership check.
  const access = await deps.authorize({ id: user.userId, role: "reader" }, link.threadId);
  if (!access.ok) {
    if (access.reason === "not_found") return { outcome: "thread-not-found" };
    log.warn("Teams sender resolved but cannot access linked thread", {
      workspaceId: deps.workspaceId,
      threadId: link.threadId,
    });
    return { outcome: "forbidden" };
  }

  // 5. Create via the SHARED path with origin=teams (loop guard for #550).
  const message = await deps.createMessage({
    threadId: link.threadId,
    authorUserId: user.userId,
    projectId: access.projectId,
    body,
    origin: "teams",
  });

  log.info("Ingested Teams message as DiscussionMessage", {
    workspaceId: deps.workspaceId,
    threadId: link.threadId,
    messageId: message.id,
  });

  // 6. AI PARTICIPANT (#552). After ingesting the human message, run the SAME
  //    AI gate + responder the in-app `ai-respond` path uses. The gate honors the
  //    thread's `aiResponseMode` (off → never; on_mention → @AI only; auto →
  //    detected question/request), and the responder persists an
  //    `authorKind=ai, origin=metis` reply that #550 mirrors back into the Teams
  //    channel (a single send — no double-post). This is fully delegated +
  //    NON-BLOCKING for the ingest result: an AI failure never changes the
  //    "ingested" outcome (the human message is already persisted).
  await runAIParticipant(context, deps, link.threadId, access.projectId, user.userId, message.id);

  return { outcome: "ingested", messageId: message.id };
}

/**
 * Read the thread's `aiResponseMode` and delegate to the AI participant. The
 * `aiResponseMode` is NOT returned by the authorization check, so we read it
 * here (the only extra DB touch on the ingest path, and only after the message
 * is safely persisted). Best-effort: any failure is logged and swallowed — the
 * human message is already ingested and must not be undone by an AI hiccup.
 */
async function runAIParticipant(
  context: TurnContext,
  deps: InboundSyncDeps,
  threadId: string,
  projectId: string,
  authorUserId: string,
  messageId: string,
): Promise<void> {
  try {
    const thread = await deps.db.discussionThread.findFirst({
      where: { id: threadId, deletedAt: null },
      select: { aiResponseMode: true },
    });
    if (!thread) return;

    await deps.respondAsAI(context, {
      threadId,
      projectId,
      aiResponseMode: thread.aiResponseMode,
      messageId,
      authorUserId,
    });
  } catch (err) {
    log.warn("Teams AI participant step failed (ingest unaffected)", {
      workspaceId: deps.workspaceId,
      threadId,
      message: (err as Error).message,
    });
  }
}

/**
 * Per-conversation, once-ish hint inviting an unmapped sender to link their
 * METIS account. Best-effort: a send failure is swallowed (never breaks the
 * turn). We de-duplicate per (workspace, conversation) within the process so a
 * chatty unmapped user is not spammed on every message.
 */
const hintedConversations = new Set<string>();

async function postUnmappedHint(context: TurnContext, workspaceId: string): Promise<void> {
  const conversationId = context.activity.conversation?.id ?? "";
  const key = `${workspaceId}:${conversationId}`;
  if (hintedConversations.has(key)) return;
  hintedConversations.add(key);
  try {
    await context.sendActivity(
      "Your Teams account isn't linked to a METIS user yet, so your message wasn't added to the discussion. Ask a workspace admin to link your account in METIS.",
    );
  } catch (err) {
    log.warn("Failed to post unmapped-sender hint to Teams channel", {
      workspaceId,
      message: (err as Error).message,
    });
  }
}

/** Test helper — clear the per-process unmapped-hint dedupe set. */
export function __resetInboundHintState(): void {
  hintedConversations.clear();
}
