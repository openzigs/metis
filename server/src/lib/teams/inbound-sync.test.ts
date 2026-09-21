/**
 * Epic #547 (Phase 2, #551) — INBOUND message sync tests.
 *
 * Every collaborator is a stub: a fake TurnContext (activity + sendActivity
 * capture), stub link store + identity resolver, an injected authorize fn, and
 * an injected createMessage. No live Teams tenant, Prisma, or network.
 *
 * Matrix:
 *   - linked channel + mapped sender + access → DiscussionMessage(origin=teams) created
 *   - non-message activity → ignored
 *   - bot's own/echoed activity (from.id === recipient.id) → ignored (loop guard)
 *   - unlinked / inactive-link channel → ignored
 *   - empty / mention-only text → ignored
 *   - unmapped sender → not created + one-time hint posted (deduped)
 *   - resolved user lacks thread access → rejected (forbidden / not_found)
 *   - tenant resolution: activity channelData > conversation > link fallback
 *   - end-to-end loop guard: teams-origin passed to createMessage
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityTypes, type Activity, type TurnContext } from "botbuilder";

import {
  ingestTeamsActivity,
  __resetInboundHintState,
  type InboundSyncOptions,
} from "./inbound-sync.js";
import { loadTeamsTenantAllowlist } from "./tenant-allowlist.js";
import type { ChannelLinkSummary, TeamsChannelLinkStore } from "./channel-link-store.js";
import type { ResolvedMetisUser, TeamsAadIdentityResolver } from "./aad-identity-resolver.js";
import type { canAccessThread } from "../discussions/access.js";
import type { createHumanDiscussionMessage } from "../discussions/create-message.js";

const WS = "ws-1";
const THREAD = "th-1";
const CONVO = "convo-1";
const BOT_ID = "28:bot-app-id";
const USER_AAD = "aad-user-1";
const TENANT = "tenant-a";

function link(over: Partial<ChannelLinkSummary> = {}): ChannelLinkSummary {
  return {
    id: "lnk-1",
    workspaceId: WS,
    threadId: THREAD,
    projectId: "pr-1",
    conversationId: CONVO,
    channelId: "msteams",
    tenantId: TENANT,
    status: "active",
    createdById: "u-1",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

function user(): ResolvedMetisUser {
  return { userId: "u-99", username: "alice", email: "alice@example.com" };
}

function fakeContext(activity: Partial<Activity>): {
  context: TurnContext;
  sent: string[];
} {
  const sent: string[] = [];
  const context = {
    activity: {
      type: ActivityTypes.Message,
      text: "hello team",
      from: { id: "29:teams-user", aadObjectId: USER_AAD },
      recipient: { id: BOT_ID },
      conversation: { id: CONVO },
      channelData: { tenant: { id: TENANT } },
      ...activity,
    } as Activity,
    sendActivity: vi.fn(async (text: string) => {
      sent.push(text);
    }),
  } as unknown as TurnContext;
  return { context, sent };
}

interface Harness {
  opts: InboundSyncOptions;
  linkStore: { getByConversation: ReturnType<typeof vi.fn> };
  resolver: { resolveUserFromAadObjectId: ReturnType<typeof vi.fn> };
  authorize: ReturnType<typeof vi.fn>;
  createMessage: ReturnType<typeof vi.fn>;
  respondAsAI: ReturnType<typeof vi.fn>;
  findThread: ReturnType<typeof vi.fn>;
  rateLimit: ReturnType<typeof vi.fn>;
}

function harness(
  over: {
    link?: ChannelLinkSummary | null;
    user?: ResolvedMetisUser | null;
    access?: { ok: boolean; projectId?: string; reason?: "not_found" | "forbidden" };
    aiResponseMode?: string | null;
    /** Override the tenant allowlist env string (default: allow-all). */
    allowedTenants?: string;
    /** Override the inbound rate-limit decision (default: always allowed). */
    rateLimitResult?: { allowed: boolean; limit?: number; retryAfterMs?: number };
  } = {},
): Harness {
  const linkStore = {
    getByConversation: vi.fn().mockResolvedValue(over.link === undefined ? link() : over.link),
  };
  const resolver = {
    resolveUserFromAadObjectId: vi
      .fn()
      .mockResolvedValue(over.user === undefined ? user() : over.user),
  };
  const authorize = vi.fn().mockResolvedValue(over.access ?? { ok: true, projectId: "pr-1" });
  const createMessage = vi.fn().mockResolvedValue({ id: "msg-7" });
  const respondAsAI = vi.fn().mockResolvedValue({ outcome: "responded", messageId: "ai-1" });
  // Thread lookup for the AI step's aiResponseMode (default on_mention).
  const findThread = vi
    .fn()
    .mockResolvedValue(
      over.aiResponseMode === null ? null : { aiResponseMode: over.aiResponseMode ?? "on_mention" },
    );
  const db = {
    discussionThread: { findFirst: findThread },
  } as unknown as InboundSyncOptions["db"];
  const rateLimit = vi
    .fn()
    .mockResolvedValue(over.rateLimitResult ?? { allowed: true, remaining: 1 });
  const opts: InboundSyncOptions = {
    workspaceId: WS,
    linkStore: linkStore as unknown as TeamsChannelLinkStore,
    identityResolver: resolver as unknown as TeamsAadIdentityResolver,
    authorize: authorize as unknown as typeof canAccessThread,
    createMessage: createMessage as unknown as typeof createHumanDiscussionMessage,
    respondAsAI: respondAsAI as unknown as InboundSyncOptions["respondAsAI"],
    db,
    tenantPolicy: loadTeamsTenantAllowlist(
      over.allowedTenants === undefined ? {} : { TEAMS_ALLOWED_TENANTS: over.allowedTenants },
    ),
    rateLimit: rateLimit as unknown as InboundSyncOptions["rateLimit"],
  };
  return {
    opts,
    linkStore,
    resolver,
    authorize,
    createMessage,
    respondAsAI,
    findThread,
    rateLimit,
  };
}

beforeEach(() => {
  __resetInboundHintState();
});

describe("ingestTeamsActivity", () => {
  it("ingests a linked + mapped + authorized message as origin=teams", async () => {
    const h = harness();
    const { context } = fakeContext({});
    const res = await ingestTeamsActivity(context, h.opts);

    expect(res.outcome).toBe("ingested");
    expect(res.messageId).toBe("msg-7");
    expect(h.createMessage).toHaveBeenCalledTimes(1);
    expect(h.createMessage.mock.calls[0][0]).toMatchObject({
      threadId: THREAD,
      authorUserId: "u-99",
      projectId: "pr-1",
      origin: "teams",
      body: "hello team",
    });
  });

  it("strips the leading bot @mention from the ingested body", async () => {
    const h = harness();
    const { context } = fakeContext({
      text: "<at>METIS</at> please summarize",
      entities: [
        {
          type: "mention",
          text: "<at>METIS</at>",
          mentioned: { id: BOT_ID, name: "METIS" },
        },
      ] as unknown as Activity["entities"],
    });
    await ingestTeamsActivity(context, h.opts);
    expect(h.createMessage.mock.calls[0][0].body).toBe("please summarize");
  });

  it("treats a mention-only message (empty after stripping) as empty-text", async () => {
    const h = harness();
    const { context } = fakeContext({
      text: "<at>METIS</at>",
      entities: [
        {
          type: "mention",
          text: "<at>METIS</at>",
          mentioned: { id: BOT_ID, name: "METIS" },
        },
      ] as unknown as Activity["entities"],
    });
    const res = await ingestTeamsActivity(context, h.opts);
    expect(res.outcome).toBe("empty-text");
    expect(h.createMessage).not.toHaveBeenCalled();
  });

  it("ignores a non-message activity", async () => {
    const h = harness();
    const { context } = fakeContext({ type: ActivityTypes.ConversationUpdate });
    const res = await ingestTeamsActivity(context, h.opts);
    expect(res.outcome).toBe("not-message");
    expect(h.linkStore.getByConversation).not.toHaveBeenCalled();
    expect(h.createMessage).not.toHaveBeenCalled();
  });

  it("ignores the bot's OWN/echoed activity (loop guard: from === recipient)", async () => {
    const h = harness();
    const { context } = fakeContext({
      from: { id: BOT_ID, aadObjectId: undefined },
      recipient: { id: BOT_ID },
    });
    const res = await ingestTeamsActivity(context, h.opts);
    expect(res.outcome).toBe("bot-own-message");
    expect(h.linkStore.getByConversation).not.toHaveBeenCalled();
    expect(h.createMessage).not.toHaveBeenCalled();
  });

  it("ignores a message in an UNLINKED channel", async () => {
    const h = harness({ link: null });
    const { context } = fakeContext({});
    const res = await ingestTeamsActivity(context, h.opts);
    expect(res.outcome).toBe("no-link");
    expect(h.resolver.resolveUserFromAadObjectId).not.toHaveBeenCalled();
    expect(h.createMessage).not.toHaveBeenCalled();
  });

  it("ignores a message on an INACTIVE link", async () => {
    const h = harness({ link: link({ status: "disabled" }) });
    const { context } = fakeContext({});
    const res = await ingestTeamsActivity(context, h.opts);
    expect(res.outcome).toBe("no-link");
    expect(h.createMessage).not.toHaveBeenCalled();
  });

  it("ignores an activity with no conversation id", async () => {
    const h = harness();
    const { context } = fakeContext({ conversation: undefined });
    const res = await ingestTeamsActivity(context, h.opts);
    expect(res.outcome).toBe("no-link");
  });

  it("skips an empty / whitespace-only message", async () => {
    const h = harness();
    const { context } = fakeContext({ text: "   " });
    const res = await ingestTeamsActivity(context, h.opts);
    expect(res.outcome).toBe("empty-text");
    expect(h.resolver.resolveUserFromAadObjectId).not.toHaveBeenCalled();
    expect(h.createMessage).not.toHaveBeenCalled();
  });

  it("does NOT create a message for an UNMAPPED sender and posts a one-time hint", async () => {
    const h = harness({ user: null });
    const { context, sent } = fakeContext({});
    const res = await ingestTeamsActivity(context, h.opts);
    expect(res.outcome).toBe("unmapped-sender");
    expect(h.createMessage).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/isn't linked/i);
  });

  it("de-duplicates the unmapped-sender hint per conversation", async () => {
    const h = harness({ user: null });
    const c1 = fakeContext({});
    const c2 = fakeContext({});
    await ingestTeamsActivity(c1.context, h.opts);
    await ingestTeamsActivity(c2.context, h.opts);
    expect(c1.sent).toHaveLength(1);
    expect(c2.sent).toHaveLength(0); // same (workspace, conversation) → no repeat
  });

  it("swallows a failure to post the unmapped hint (best-effort)", async () => {
    const h = harness({ user: null });
    const { context } = fakeContext({});
    (context.sendActivity as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("channel gone"),
    );
    const res = await ingestTeamsActivity(context, h.opts);
    expect(res.outcome).toBe("unmapped-sender");
  });

  it("rejects when the resolved user lacks thread access (forbidden)", async () => {
    const h = harness({ access: { ok: false, reason: "forbidden" } });
    const { context } = fakeContext({});
    const res = await ingestTeamsActivity(context, h.opts);
    expect(res.outcome).toBe("forbidden");
    expect(h.createMessage).not.toHaveBeenCalled();
  });

  it("reports thread-not-found when the linked thread is gone", async () => {
    const h = harness({ access: { ok: false, reason: "not_found" } });
    const { context } = fakeContext({});
    const res = await ingestTeamsActivity(context, h.opts);
    expect(res.outcome).toBe("thread-not-found");
    expect(h.createMessage).not.toHaveBeenCalled();
  });

  it("authorizes the RESOLVED user (not the raw sender) against the link's thread", async () => {
    const h = harness();
    const { context } = fakeContext({});
    await ingestTeamsActivity(context, h.opts);
    expect(h.authorize).toHaveBeenCalledWith({ id: "u-99", role: "reader" }, THREAD);
  });

  it("treats an activity with no sender id as a normal (non-bot) message", async () => {
    const h = harness({ user: null });
    const { context } = fakeContext({ from: undefined, recipient: { id: BOT_ID } });
    const res = await ingestTeamsActivity(context, h.opts);
    // No from.id → not flagged as the bot's own message; resolver gets null aad.
    expect(res.outcome).toBe("unmapped-sender");
    expect(h.resolver.resolveUserFromAadObjectId).toHaveBeenCalledWith(TENANT, null);
  });

  it("passes a null aadObjectId when the sender carries none", async () => {
    const h = harness({ user: null });
    const { context } = fakeContext({ from: { id: "29:teams-user", aadObjectId: undefined } });
    await ingestTeamsActivity(context, h.opts);
    expect(h.resolver.resolveUserFromAadObjectId).toHaveBeenCalledWith(TENANT, null);
  });

  it("wires real default collaborators when only some are injected", async () => {
    // Provide a stub link store that returns no link, but omit identityResolver,
    // authorize, and createMessage → resolveDeps fills them with the real
    // singletons. A no-link channel skips before any of them runs, so this safely
    // exercises the default-deps branch without a live tenant or DB write.
    const linkStore = {
      getByConversation: vi.fn().mockResolvedValue(null),
    } as unknown as TeamsChannelLinkStore;
    const { context } = fakeContext({ conversation: { id: "unlinked-convo" } });
    const res = await ingestTeamsActivity(context, { workspaceId: "ws-none", linkStore });
    expect(res.outcome).toBe("no-link");
  });

  it("resolves tenant from activity channelData first", async () => {
    const h = harness();
    const { context } = fakeContext({ channelData: { tenant: { id: "tenant-from-activity" } } });
    await ingestTeamsActivity(context, h.opts);
    expect(h.resolver.resolveUserFromAadObjectId).toHaveBeenCalledWith(
      "tenant-from-activity",
      USER_AAD,
    );
  });

  it("falls back to the link's tenant when the activity carries none", async () => {
    const h = harness();
    const { context } = fakeContext({ channelData: undefined, conversation: { id: CONVO } });
    await ingestTeamsActivity(context, h.opts);
    expect(h.resolver.resolveUserFromAadObjectId).toHaveBeenCalledWith(TENANT, USER_AAD);
  });

  it("uses the conversation tenantId when channelData is absent", async () => {
    const h = harness();
    const { context } = fakeContext({
      channelData: undefined,
      conversation: { id: CONVO, tenantId: "tenant-from-convo" } as Activity["conversation"],
    });
    await ingestTeamsActivity(context, h.opts);
    expect(h.resolver.resolveUserFromAadObjectId).toHaveBeenCalledWith(
      "tenant-from-convo",
      USER_AAD,
    );
  });

  // ---- #552 AI participant wiring -----------------------------------------

  it("runs the AI participant after ingesting, with the thread's mode + trigger", async () => {
    const h = harness({ aiResponseMode: "auto" });
    const { context } = fakeContext({ text: "@AI summarize" });
    const res = await ingestTeamsActivity(context, h.opts);

    expect(res.outcome).toBe("ingested");
    expect(h.respondAsAI).toHaveBeenCalledTimes(1);
    expect(h.respondAsAI.mock.calls[0][1]).toMatchObject({
      threadId: THREAD,
      projectId: "pr-1",
      aiResponseMode: "auto",
      messageId: "msg-7",
      authorUserId: "u-99",
    });
  });

  it("does NOT run the AI participant when no human message is ingested (unmapped sender)", async () => {
    const h = harness({ user: null });
    const { context } = fakeContext({ text: "@AI summarize" });
    await ingestTeamsActivity(context, h.opts);
    expect(h.respondAsAI).not.toHaveBeenCalled();
  });

  it("skips the AI participant when the thread row is gone at read time", async () => {
    const h = harness({ aiResponseMode: null });
    const { context } = fakeContext({ text: "@AI summarize" });
    const res = await ingestTeamsActivity(context, h.opts);
    expect(res.outcome).toBe("ingested");
    expect(h.respondAsAI).not.toHaveBeenCalled();
  });

  it("still reports the human message as ingested when the AI step throws", async () => {
    const h = harness();
    h.respondAsAI.mockRejectedValueOnce(new Error("ai boom"));
    const { context } = fakeContext({ text: "@AI summarize" });
    const res = await ingestTeamsActivity(context, h.opts);
    expect(res.outcome).toBe("ingested");
    expect(res.messageId).toBe("msg-7");
  });

  // ---- #554 tenant allowlist ----------------------------------------------

  it("allows any tenant when no allowlist is configured (default)", async () => {
    const h = harness({ allowedTenants: undefined });
    const { context } = fakeContext({ channelData: { tenant: { id: "any-tenant" } } });
    const res = await ingestTeamsActivity(context, h.opts);
    expect(res.outcome).toBe("ingested");
  });

  it("ingests an activity from an allowlisted tenant", async () => {
    const h = harness({ allowedTenants: "tenant-a" });
    const { context } = fakeContext({ channelData: { tenant: { id: "tenant-a" } } });
    const res = await ingestTeamsActivity(context, h.opts);
    expect(res.outcome).toBe("ingested");
    expect(h.createMessage).toHaveBeenCalledTimes(1);
  });

  it("REJECTS an activity from a non-allowlisted tenant (even though authed)", async () => {
    const h = harness({ allowedTenants: "tenant-a" });
    const { context } = fakeContext({ channelData: { tenant: { id: "tenant-evil" } } });
    const res = await ingestTeamsActivity(context, h.opts);
    expect(res.outcome).toBe("tenant-not-allowed");
    // Rejected BEFORE any sender resolution, message write, or AI call.
    expect(h.resolver.resolveUserFromAadObjectId).not.toHaveBeenCalled();
    expect(h.createMessage).not.toHaveBeenCalled();
    expect(h.respondAsAI).not.toHaveBeenCalled();
  });

  it("rejects when the activity carries no tenant and the link tenant is not allowlisted", async () => {
    const h = harness({ allowedTenants: "tenant-a", link: link({ tenantId: "tenant-z" }) });
    const { context } = fakeContext({ channelData: undefined, conversation: { id: CONVO } });
    const res = await ingestTeamsActivity(context, h.opts);
    expect(res.outcome).toBe("tenant-not-allowed");
  });

  // ---- #554 inbound rate limit --------------------------------------------

  it("rate-limits inbound activity once the per-conversation cap is reached", async () => {
    const h = harness({ rateLimitResult: { allowed: false, limit: 30, retryAfterMs: 5000 } });
    const { context } = fakeContext({});
    const res = await ingestTeamsActivity(context, h.opts);
    expect(res.outcome).toBe("rate-limited");
    // No write, no identity resolve, no AI when capped.
    expect(h.resolver.resolveUserFromAadObjectId).not.toHaveBeenCalled();
    expect(h.createMessage).not.toHaveBeenCalled();
  });

  it("checks the rate limit keyed by (workspace, conversation)", async () => {
    const h = harness();
    const { context } = fakeContext({});
    await ingestTeamsActivity(context, h.opts);
    expect(h.rateLimit).toHaveBeenCalledTimes(1);
    expect(h.rateLimit.mock.calls[0][0]).toMatchObject({
      workspaceId: WS,
      conversationId: CONVO,
    });
  });

  it("fails OPEN (still ingests) when the rate-limit backend errors", async () => {
    const h = harness();
    h.rateLimit.mockRejectedValueOnce(new Error("store down"));
    const { context } = fakeContext({});
    const res = await ingestTeamsActivity(context, h.opts);
    expect(res.outcome).toBe("ingested");
    expect(h.createMessage).toHaveBeenCalledTimes(1);
  });

  it("does NOT consume rate-limit budget for an unbridged channel", async () => {
    const h = harness({ link: null });
    const { context } = fakeContext({});
    await ingestTeamsActivity(context, h.opts);
    expect(h.rateLimit).not.toHaveBeenCalled();
  });
});
