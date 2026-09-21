/**
 * Epic #547 (Phase 3, #553) — promote-from-Teams handler tests.
 *
 * The handler reacts to the Adaptive Card "Promote to requirement" Action.Submit
 * (delivered as a `message` activity carrying `activity.value`). It:
 *   - resolves the acting user via the #549 AAD→METIS resolver,
 *   - authorizes them on the thread via #477 `canAccessThread` (reader role),
 *   - correlates the click to the source `DiscussionMessage` (rides in the
 *     submit `value`, no schema), and calls the EXISTING `promote.ts`,
 *   - posts a confirmation card on success / a clear refusal card on every
 *     failure (unmapped, unauthorized, bad correlation, promote error).
 *
 * Everything is injected so the handler is unit-tested with no live Azure tenant,
 * Prisma, or network.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { TurnContext } from "botbuilder";

import {
  isPromoteSubmit,
  handleTeamsPromoteSubmit,
  deriveTitleFromBody,
  type PromoteHandlerDeps,
  type PromoteHandlerResult,
} from "./teams-promote.js";
import { PromoteError } from "../discussions/promote.js";
import type { ResolvedMetisUser } from "./aad-identity-resolver.js";
import { loadTeamsTenantAllowlist } from "./tenant-allowlist.js";

const WS = "ws-1";
const TENANT = "tenant-1";
const AAD = "aad-oid-1";
const THREAD = "thread-1";
const MSG = "msg-1";
const PROJECT = "project-1";

/** Build a fake submit TurnContext. */
function makeContext(opts: {
  value?: unknown;
  tenantId?: string | null;
  aadObjectId?: string | null;
}): { context: TurnContext; sent: Array<{ attachments?: unknown[]; text?: string }> } {
  const sent: Array<{ attachments?: unknown[]; text?: string }> = [];
  const context = {
    activity: {
      type: "message",
      value:
        opts.value === undefined
          ? { metisAction: "promote", threadId: THREAD, messageId: MSG }
          : opts.value,
      from: { aadObjectId: opts.aadObjectId === undefined ? AAD : opts.aadObjectId },
      conversation: {
        id: "conv-1",
        tenantId: opts.tenantId === undefined ? TENANT : opts.tenantId,
      },
      channelData: {},
    },
    sendActivity: vi.fn(async (activity: { attachments?: unknown[]; text?: string } | string) => {
      sent.push(typeof activity === "string" ? { text: activity } : activity);
      return { id: "sent-1" };
    }),
  } as unknown as TurnContext;
  return { context, sent };
}

function user(): ResolvedMetisUser {
  return { userId: "user-1", username: "ada", email: "ada@example.com" };
}

function makeDeps(over: Partial<PromoteHandlerDeps> = {}): PromoteHandlerDeps {
  return {
    workspaceId: WS,
    resolver: {
      resolveUserFromAadObjectId: vi.fn(async () => user()),
    } as unknown as PromoteHandlerDeps["resolver"],
    authorize: vi.fn(async () => ({ ok: true, projectId: PROJECT })) as never,
    promote: vi.fn(async () => ({
      requirementId: "req-1",
      analysisId: "an-1",
      analysisIdSource: "latest-analysis" as const,
    })),
    db: {
      discussionMessage: {
        findFirst: vi.fn(async () => ({ id: MSG, body: "Build the export feature for finance" })),
      },
    } as unknown as PromoteHandlerDeps["db"],
    ...over,
  };
}

beforeEach(() => vi.restoreAllMocks());

describe("isPromoteSubmit", () => {
  it("recognises a promote submit activity by value.metisAction", () => {
    const { context } = makeContext({});
    expect(isPromoteSubmit(context.activity)).toBe(true);
  });

  it("ignores a plain text message (no value)", () => {
    const { context } = makeContext({ value: undefined });
    // override value to undefined entirely
    (context.activity as { value?: unknown }).value = undefined;
    expect(isPromoteSubmit(context.activity)).toBe(false);
  });

  it("ignores a submit for a different action", () => {
    const { context } = makeContext({ value: { metisAction: "somethingElse" } });
    expect(isPromoteSubmit(context.activity)).toBe(false);
  });

  it("ignores a non-message activity", () => {
    const { context } = makeContext({});
    (context.activity as { type?: string }).type = "invoke";
    expect(isPromoteSubmit(context.activity)).toBe(false);
  });
});

describe("handleTeamsPromoteSubmit — authorized member (happy path)", () => {
  it("resolves the user, authorizes, calls promote.ts, and posts a confirmation card", async () => {
    const { context, sent } = makeContext({});
    const deps = makeDeps();

    const res: PromoteHandlerResult = await handleTeamsPromoteSubmit(context, deps);

    expect(res.outcome).toBe("promoted");
    expect(res.requirementId).toBe("req-1");

    // promote.ts called with the REAL resolved user as actor + correlated ids.
    expect(deps.promote).toHaveBeenCalledTimes(1);
    const arg = (deps.promote as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.actor.id).toBe("user-1");
    expect(arg.threadId).toBe(THREAD);
    expect(arg.messageId).toBe(MSG);
    expect(typeof arg.title).toBe("string");
    expect(arg.title.length).toBeGreaterThan(0);

    // authorize ran at the LOWEST privilege (reader) — access must be earned.
    const authArg = (deps.authorize as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(authArg[0]).toMatchObject({ id: "user-1", role: "reader" });
    expect(authArg[1]).toBe(THREAD);

    // A confirmation card mentioning the requirement is posted back to Teams.
    expect(context.sendActivity).toHaveBeenCalledTimes(1);
    const card = JSON.stringify(sent[0]);
    expect(card.toLowerCase()).toContain("requirement");
    expect(card).toContain("req-1");
  });

  it("derives a non-empty title from the source message body", async () => {
    const { context } = makeContext({});
    const deps = makeDeps({
      db: {
        discussionMessage: {
          findFirst: vi.fn(async () => ({
            id: MSG,
            body: "First meaningful line\nsecond line that should be dropped",
          })),
        },
      } as unknown as PromoteHandlerDeps["db"],
    });

    await handleTeamsPromoteSubmit(context, deps);
    const arg = (deps.promote as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.title).toBe("First meaningful line");
  });
});

describe("handleTeamsPromoteSubmit — refusals (never promote)", () => {
  it("refuses an unmapped sender (resolver → null), never calling promote", async () => {
    const { context, sent } = makeContext({});
    const deps = makeDeps({
      resolver: {
        resolveUserFromAadObjectId: vi.fn(async () => null),
      } as unknown as PromoteHandlerDeps["resolver"],
    });

    const res = await handleTeamsPromoteSubmit(context, deps);
    expect(res.outcome).toBe("unmapped-sender");
    expect(deps.promote).not.toHaveBeenCalled();
    expect(JSON.stringify(sent[0]).toLowerCase()).toMatch(/link|account|not.*linked/);
  });

  it("refuses an unauthorized (non-member) user with reason forbidden", async () => {
    const { context, sent } = makeContext({});
    const deps = makeDeps({
      authorize: vi.fn(async () => ({ ok: false, reason: "forbidden" })) as never,
    });

    const res = await handleTeamsPromoteSubmit(context, deps);
    expect(res.outcome).toBe("forbidden");
    expect(deps.promote).not.toHaveBeenCalled();
    expect(JSON.stringify(sent[0]).toLowerCase()).toMatch(/access|permission|member/);
  });

  it("reports thread-not-found when the thread is missing/soft-deleted", async () => {
    const { context, sent } = makeContext({});
    const deps = makeDeps({
      authorize: vi.fn(async () => ({ ok: false, reason: "not_found" })) as never,
    });

    const res = await handleTeamsPromoteSubmit(context, deps);
    expect(res.outcome).toBe("thread-not-found");
    expect(deps.promote).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
  });

  it("gracefully errors when the submit value omits the correlation ids", async () => {
    const { context, sent } = makeContext({ value: { metisAction: "promote" } });
    const deps = makeDeps();

    const res = await handleTeamsPromoteSubmit(context, deps);
    expect(res.outcome).toBe("bad-correlation");
    expect(deps.promote).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
  });

  it("errors when the correlated message no longer exists in the thread", async () => {
    const { context, sent } = makeContext({});
    const deps = makeDeps({
      db: {
        discussionMessage: { findFirst: vi.fn(async () => null) },
      } as unknown as PromoteHandlerDeps["db"],
    });

    const res = await handleTeamsPromoteSubmit(context, deps);
    expect(res.outcome).toBe("message-not-found");
    expect(deps.promote).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
  });

  it("posts an error card (no partial state) when promote.ts throws a PromoteError", async () => {
    const { context, sent } = makeContext({});
    const deps = makeDeps({
      promote: vi.fn(async () => {
        throw new PromoteError("MESSAGE_NOT_FOUND", "Message not found in this thread");
      }),
    });

    const res = await handleTeamsPromoteSubmit(context, deps);
    expect(res.outcome).toBe("promote-failed");
    expect(JSON.stringify(sent[0]).toLowerCase()).toContain("could");
  });

  it("posts a generic error card when promote.ts throws an unexpected error", async () => {
    const { context, sent } = makeContext({});
    const deps = makeDeps({
      promote: vi.fn(async () => {
        throw new Error("db exploded");
      }),
    });

    const res = await handleTeamsPromoteSubmit(context, deps);
    expect(res.outcome).toBe("promote-failed");
    expect(sent).toHaveLength(1);
    // The internal error detail is NEVER leaked back to the channel.
    expect(JSON.stringify(sent[0])).not.toContain("db exploded");
  });

  it("never throws even if sending the confirmation card fails", async () => {
    const { context } = makeContext({});
    (context.sendActivity as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("channel gone"));
    const deps = makeDeps();
    const res = await handleTeamsPromoteSubmit(context, deps);
    // Promotion still succeeded; the card send failure is swallowed.
    expect(res.outcome).toBe("promoted");
  });
});

describe("deriveTitleFromBody", () => {
  it("uses the first non-empty line, trimmed", () => {
    expect(deriveTitleFromBody("\n  hello world  \nsecond")).toBe("hello world");
  });

  it("clamps a long first line to 255 chars", () => {
    expect(deriveTitleFromBody("x".repeat(400)).length).toBe(255);
  });

  it("falls back to a neutral label for a blank body", () => {
    expect(deriveTitleFromBody("   \n  ")).toBe("Requirement promoted from Teams");
    expect(deriveTitleFromBody("")).toBe("Requirement promoted from Teams");
  });
});

describe("handleTeamsPromoteSubmit — identity tenant scoping", () => {
  it("prefers channelData.tenant.id over conversation.tenantId", async () => {
    const { context } = makeContext({});
    (context.activity as { channelData?: unknown }).channelData = {
      tenant: { id: "channel-tenant" },
    };
    const deps = makeDeps();
    await handleTeamsPromoteSubmit(context, deps);
    const call = (deps.resolver.resolveUserFromAadObjectId as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(call[0]).toBe("channel-tenant");
  });

  it("resolves the sender by the activity tenant + aadObjectId", async () => {
    const { context } = makeContext({ tenantId: TENANT, aadObjectId: AAD });
    const deps = makeDeps();
    await handleTeamsPromoteSubmit(context, deps);
    const call = (deps.resolver.resolveUserFromAadObjectId as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(call[0]).toBe(TENANT);
    expect(call[1]).toBe(AAD);
  });

  it("refuses when the sender has no aadObjectId (tenant-less / anonymous)", async () => {
    const { context } = makeContext({ aadObjectId: null });
    const deps = makeDeps({
      resolver: {
        resolveUserFromAadObjectId: vi.fn(async () => null),
      } as unknown as PromoteHandlerDeps["resolver"],
    });
    const res = await handleTeamsPromoteSubmit(context, deps);
    expect(res.outcome).toBe("unmapped-sender");
    expect(deps.promote).not.toHaveBeenCalled();
  });
});

describe("handleTeamsPromoteSubmit — #554 tenant allowlist", () => {
  it("promotes from an allowlisted tenant", async () => {
    const { context } = makeContext({ tenantId: "tenant-1" });
    const deps = makeDeps({
      tenantPolicy: loadTeamsTenantAllowlist({ TEAMS_ALLOWED_TENANTS: "tenant-1" }),
    });
    const res = await handleTeamsPromoteSubmit(context, deps);
    expect(res.outcome).toBe("promoted");
  });

  it("REFUSES a promote from a non-allowlisted tenant (before resolving the user)", async () => {
    const { context, sent } = makeContext({ tenantId: "tenant-evil" });
    const deps = makeDeps({
      tenantPolicy: loadTeamsTenantAllowlist({ TEAMS_ALLOWED_TENANTS: "tenant-1" }),
    });
    const res = await handleTeamsPromoteSubmit(context, deps);
    expect(res.outcome).toBe("tenant-not-allowed");
    expect(deps.resolver.resolveUserFromAadObjectId).not.toHaveBeenCalled();
    expect(deps.promote).not.toHaveBeenCalled();
    // A clear (non-leaky) refusal card is posted.
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0])).not.toContain("tenant-1");
  });
});
