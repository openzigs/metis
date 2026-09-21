/**
 * Epic #547 (Phase 2, #550) — OUTBOUND message sync orchestration tests.
 *
 * Every collaborator is a stub: a fake Prisma (thread→project.workspaceId +
 * user.displayName), stub link/reference/install stores, and a stub adapter
 * factory whose `continueConversationAsync` captures the proactive send. No live
 * Teams tenant, no real DB, no network — per the #548/#549 unit-test pattern.
 *
 * Matrix:
 *   - linked thread, metis-origin → proactive send with right ref + author text
 *   - human vs AI authorship rendered distinctly
 *   - unlinked thread → no send
 *   - teams-origin message → NOT mirrored (loop guard)
 *   - inactive link / missing reference / no installation → no send, swallowed
 *   - send failure → swallowed, returns {mirrored:false}, never throws
 *   - scheduleMirrorToTeams never throws
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

import {
  mirrorMessageToTeams,
  scheduleMirrorToTeams,
  type OutboundMessage,
  type OutboundSyncDeps,
} from "./outbound-sync.js";
import type { ChannelLinkSummary, TeamsChannelLinkStore } from "./channel-link-store.js";
import type {
  ConversationReferenceStore,
  StoredConversationReference,
} from "./conversation-reference-store.js";
import type { ResolvedCredentials, TeamsInstallationStore } from "./installation-store.js";
import type { BotAdapterFactory } from "./bot-adapter.js";

// ── fixtures ────────────────────────────────────────────────────────────────

const WS = "ws-1";
const THREAD = "th-1";
const CONVO = "convo-1";

function link(over: Partial<ChannelLinkSummary> = {}): ChannelLinkSummary {
  return {
    id: "lnk-1",
    workspaceId: WS,
    threadId: THREAD,
    projectId: "pr-1",
    conversationId: CONVO,
    channelId: "msteams",
    tenantId: "tenant-a",
    status: "active",
    createdById: "u-1",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

function stored(): StoredConversationReference {
  return {
    installationId: "inst-1",
    workspaceId: WS,
    conversationId: CONVO,
    serviceUrl: "https://smba.example/teams",
    tenantId: "tenant-a",
    channelId: "msteams",
    aadObjectId: "aad-1",
    userId: "29:user",
    reference: { conversation: { id: CONVO } } as StoredConversationReference["reference"],
  };
}

function creds(): ResolvedCredentials {
  return { appId: "app-123", appPassword: "secret", appType: "MultiTenant", tenantId: null };
}

function humanMessage(over: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    id: "m-1",
    threadId: THREAD,
    authorKind: "human",
    authorUserId: "u-7",
    aiModel: null,
    body: "hello from metis",
    origin: "metis",
    ...over,
  };
}

/** A captured proactive send. */
interface Capture {
  botAppId: string;
  reference: unknown;
  /** `activity.text` fallback of the sent activity. */
  sentText: string | null;
  /** The full sent activity (now an actionable Adaptive Card — #553). */
  sentActivity: {
    text?: string;
    attachments?: Array<{ contentType?: string; content?: unknown }>;
  } | null;
}

interface Harness {
  deps: OutboundSyncDeps;
  capture: Capture;
  sendActivity: ReturnType<typeof vi.fn>;
  resolveAppPassword: ReturnType<typeof vi.fn>;
  refGet: ReturnType<typeof vi.fn>;
  linkGet: ReturnType<typeof vi.fn>;
}

function makeHarness(
  opts: {
    workspaceId?: string | null;
    linkResult?: ChannelLinkSummary | null;
    refResult?: StoredConversationReference | null;
    credsResult?: ResolvedCredentials | null;
    displayName?: string | null;
    sendThrows?: boolean;
    adapterMissingMethod?: boolean;
  } = {},
): Harness {
  const capture: Capture = {
    botAppId: "",
    reference: null,
    sentText: null,
    sentActivity: null,
  };

  const sendActivity = vi.fn(async (activity: Capture["sentActivity"] | string) => {
    if (opts.sendThrows) throw new Error("Teams API 500");
    // #553: the proactive send is now an actionable Adaptive Card activity. The
    // human-readable text rides in `activity.text` (the non-card fallback).
    if (typeof activity === "string") {
      capture.sentActivity = { text: activity };
      capture.sentText = activity;
    } else {
      capture.sentActivity = activity;
      capture.sentText = activity?.text ?? null;
    }
  });

  const db = {
    discussionThread: {
      findFirst: vi.fn(async () =>
        opts.workspaceId === null ? null : { project: { workspaceId: opts.workspaceId ?? WS } },
      ),
    },
    user: {
      findUnique: vi.fn(async () =>
        opts.displayName === undefined
          ? { displayName: "Ada Lovelace" }
          : opts.displayName === null
            ? null
            : { displayName: opts.displayName },
      ),
    },
  } as unknown as PrismaClient;

  const linkGet = vi.fn(async () => (opts.linkResult === undefined ? link() : opts.linkResult));
  const linkStore = { getByThread: linkGet } as unknown as TeamsChannelLinkStore;

  const refGet = vi.fn(async () => (opts.refResult === undefined ? stored() : opts.refResult));
  const refStore = { get: refGet } as unknown as ConversationReferenceStore;

  const resolveAppPassword = vi.fn(async () =>
    opts.credsResult === undefined ? creds() : opts.credsResult,
  );
  const installStore = { resolveAppPassword } as unknown as TeamsInstallationStore;

  const adapterFactory: BotAdapterFactory = vi.fn(() => {
    const adapter: Record<string, unknown> = {};
    if (!opts.adapterMissingMethod) {
      adapter.continueConversationAsync = vi.fn(
        async (
          botAppId: string,
          reference: unknown,
          logic: (ctx: { sendActivity: typeof sendActivity }) => Promise<void>,
        ) => {
          capture.botAppId = botAppId;
          capture.reference = reference;
          await logic({ sendActivity });
        },
      );
    }
    return adapter as never;
  }) as unknown as BotAdapterFactory;

  return {
    deps: { db, linkStore, refStore, installStore, adapterFactory },
    capture,
    sendActivity,
    resolveAppPassword,
    refGet,
    linkGet,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

// ── happy path ────────────────────────────────────────────────────────────

describe("mirrorMessageToTeams — linked thread, metis origin", () => {
  it("sends a proactive message with the bot appId + stored reference", async () => {
    const h = makeHarness({ displayName: "Ada Lovelace" });
    const res = await mirrorMessageToTeams(THREAD, humanMessage(), h.deps);

    expect(res).toEqual({ mirrored: true });
    expect(h.capture.botAppId).toBe("app-123");
    expect(h.capture.reference).toEqual(stored().reference);
    expect(h.sendActivity).toHaveBeenCalledTimes(1);
  });

  it("renders a HUMAN author distinctly (bold name, no robot)", async () => {
    const h = makeHarness({ displayName: "Ada Lovelace" });
    await mirrorMessageToTeams(THREAD, humanMessage({ body: "hi all" }), h.deps);
    expect(h.capture.sentText).toBe("**Ada Lovelace**: hi all");
    expect(h.capture.sentText).not.toContain("🤖");
  });

  it("mirrors as an Adaptive Card whose Promote button carries the source message id (#553)", async () => {
    const h = makeHarness({ displayName: "Ada Lovelace" });
    await mirrorMessageToTeams(THREAD, humanMessage({ id: "src-msg-7", body: "hi" }), h.deps);

    const card = h.capture.sentActivity?.attachments?.[0]?.content as {
      actions?: Array<{ type?: string; data?: Record<string, unknown> }>;
    };
    expect(h.capture.sentActivity?.attachments?.[0]?.contentType).toBe(
      "application/vnd.microsoft.card.adaptive",
    );
    const action = (card.actions ?? [])[0];
    expect(action?.type).toBe("Action.Submit");
    expect(action?.data).toMatchObject({
      metisAction: "promote",
      threadId: THREAD,
      messageId: "src-msg-7",
    });
  });

  it("renders an AI author distinctly (robot + model)", async () => {
    const h = makeHarness();
    const ai: OutboundMessage = {
      id: "m-2",
      threadId: THREAD,
      authorKind: "ai",
      authorUserId: null,
      aiModel: "gpt-4o",
      body: "the answer",
      origin: "metis",
    };
    await mirrorMessageToTeams(THREAD, ai, h.deps);
    expect(h.capture.sentText).toBe("🤖 **METIS AI** (gpt-4o): the answer");
    // An AI message has no authorUserId → no user lookup.
    expect(h.deps.db.user.findUnique as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("defaults origin to metis when the field is absent", async () => {
    const h = makeHarness();
    const res = await mirrorMessageToTeams(THREAD, humanMessage({ origin: undefined }), h.deps);
    expect(res.mirrored).toBe(true);
  });
});

// ── loop guard ──────────────────────────────────────────────────────────────

describe("mirrorMessageToTeams — loop guard (#550)", () => {
  it("does NOT mirror a teams-origin message (no echo loop)", async () => {
    const h = makeHarness();
    const res = await mirrorMessageToTeams(THREAD, humanMessage({ origin: "teams" }), h.deps);
    expect(res).toEqual({ mirrored: false, reason: "teams-origin" });
    expect(h.linkGet).not.toHaveBeenCalled(); // bailed before any work
    expect(h.sendActivity).not.toHaveBeenCalled();
  });

  it("does not mirror an unknown non-metis origin", async () => {
    const h = makeHarness();
    const res = await mirrorMessageToTeams(THREAD, humanMessage({ origin: "slack" }), h.deps);
    expect(res.mirrored).toBe(false);
    expect(h.sendActivity).not.toHaveBeenCalled();
  });
});

// ── unlinked / no-op paths ───────────────────────────────────────────────────

describe("mirrorMessageToTeams — no-op paths", () => {
  it("does not send when the thread has no link", async () => {
    const h = makeHarness({ linkResult: null });
    const res = await mirrorMessageToTeams(THREAD, humanMessage(), h.deps);
    expect(res).toEqual({ mirrored: false, reason: "no-link" });
    expect(h.sendActivity).not.toHaveBeenCalled();
  });

  it("does not send when the thread's project is missing/deleted", async () => {
    const h = makeHarness({ workspaceId: null });
    const res = await mirrorMessageToTeams(THREAD, humanMessage(), h.deps);
    expect(res).toEqual({ mirrored: false, reason: "no-link" });
    expect(h.linkGet).not.toHaveBeenCalled();
  });

  it("does not send when the link is not active", async () => {
    const h = makeHarness({ linkResult: link({ status: "revoked" }) });
    const res = await mirrorMessageToTeams(THREAD, humanMessage(), h.deps);
    expect(res).toEqual({ mirrored: false, reason: "link-inactive" });
    expect(h.sendActivity).not.toHaveBeenCalled();
  });

  it("does not send when there is no stored conversation reference", async () => {
    const h = makeHarness({ refResult: null });
    const res = await mirrorMessageToTeams(THREAD, humanMessage(), h.deps);
    expect(res).toEqual({ mirrored: false, reason: "no-reference" });
    expect(h.sendActivity).not.toHaveBeenCalled();
  });
});

// ── robustness: failures swallowed, never break the caller ──────────────────

describe("mirrorMessageToTeams — failures are isolated (best-effort)", () => {
  it("swallows a missing installation (uninstalled app)", async () => {
    const h = makeHarness({ credsResult: null });
    const res = await mirrorMessageToTeams(THREAD, humanMessage(), h.deps);
    expect(res).toEqual({ mirrored: false, reason: "error" });
    expect(h.sendActivity).not.toHaveBeenCalled();
  });

  it("swallows a Teams API / send failure and returns {mirrored:false}", async () => {
    const h = makeHarness({ sendThrows: true });
    const res = await mirrorMessageToTeams(THREAD, humanMessage(), h.deps);
    expect(res).toEqual({ mirrored: false, reason: "error" });
    // The send was attempted but threw — and we swallowed it.
    expect(h.sendActivity).toHaveBeenCalledTimes(1);
  });

  it("swallows an adapter that cannot send proactively", async () => {
    const h = makeHarness({ adapterMissingMethod: true });
    const res = await mirrorMessageToTeams(THREAD, humanMessage(), h.deps);
    expect(res).toEqual({ mirrored: false, reason: "error" });
  });

  it("never throws even if the link lookup itself rejects", async () => {
    const h = makeHarness();
    (h.deps.linkStore.getByThread as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("db down"),
    );
    const res = await mirrorMessageToTeams(THREAD, humanMessage(), h.deps);
    expect(res).toEqual({ mirrored: false, reason: "error" });
  });

  it("falls back to a neutral name when the human author is not found", async () => {
    const h = makeHarness({ displayName: null });
    await mirrorMessageToTeams(THREAD, humanMessage({ body: "hey" }), h.deps);
    expect(h.capture.sentText).toBe("**METIS user**: hey");
  });
});

// ── fire-and-forget wrapper ──────────────────────────────────────────────────

describe("scheduleMirrorToTeams", () => {
  it("returns void synchronously and never throws", () => {
    // No overrides → uses real default singletons, but with no IO/DB the
    // mirror just resolves to a no-op/error internally and is swallowed.
    expect(() => scheduleMirrorToTeams(THREAD, humanMessage({ origin: "teams" }))).not.toThrow();
  });
});
