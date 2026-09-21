/**
 * Epic #63 (#578) — Teams ChatOps command + approve-button handler tests.
 *
 * All collaborators are injected, so the handlers are unit-tested with a fake
 * TurnContext + stubs — no live Azure tenant, Prisma, approval service, or
 * network. The matrix covers: command parsing, `/metis status` (linked channel +
 * explicit ref), `/metis approve` prompt, the Approve Action.Submit (approval
 * service invoked + confirmation), and every refusal — unmapped sender,
 * unauthorized role, non-member, non-allowlisted tenant, bad/unknown draft,
 * approval-service failure, and rate-limit.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { TurnContext } from "botbuilder";

import {
  parseMetisCommand,
  isMetisCommandText,
  isApproveSubmit,
  stripBotMention,
  handleTeamsStatusCommand,
  handleTeamsApproveCommand,
  handleTeamsApproveSubmit,
  type CommandOptions,
  type CommandResult,
} from "./teams-command.js";
import { PublishError } from "../publishing/types.js";
import { loadTeamsTenantAllowlist } from "./tenant-allowlist.js";
import type { ResolvedMetisUser } from "./aad-identity-resolver.js";

const WS = "ws-1";
const TENANT = "tenant-1";
const AAD = "aad-oid-1";
const PROJECT = "project-1";
const DRAFT = "draft-1";

function makeContext(opts: {
  text?: string;
  value?: unknown;
  tenantId?: string | null;
  aadObjectId?: string | null;
  conversationId?: string;
}): { context: TurnContext; sent: Array<{ attachments?: unknown[]; text?: string }> } {
  const sent: Array<{ attachments?: unknown[]; text?: string }> = [];
  const context = {
    activity: {
      type: "message",
      text: opts.text ?? "",
      value: opts.value,
      from: { aadObjectId: opts.aadObjectId === undefined ? AAD : opts.aadObjectId },
      conversation: {
        id: opts.conversationId ?? "conv-1",
        tenantId: opts.tenantId === undefined ? TENANT : opts.tenantId,
      },
      recipient: { id: "28:bot" },
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

/** Build deps wiring every collaborator to a stub. `roleKey` is the actor's role. */
function makeOpts(over: Partial<CommandOptions> & { roleKey?: string } = {}): CommandOptions {
  const roleKey = over.roleKey ?? "coordinator";
  return {
    workspaceId: WS,
    resolver: {
      resolveUserFromAadObjectId: vi.fn(async () => user()),
    } as unknown as CommandOptions["resolver"],
    linkStore: {
      getByConversation: vi.fn(async () => ({
        id: "link-1",
        workspaceId: WS,
        threadId: "thread-1",
        projectId: PROJECT,
        conversationId: "conv-1",
        channelId: "msteams",
        tenantId: TENANT,
        status: "active",
        createdById: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
    } as unknown as CommandOptions["linkStore"],
    db: {
      userRole: { findFirst: vi.fn(async () => ({ role: { key: roleKey } })) },
      issueDraft: {
        findFirst: vi.fn(async () => ({ id: DRAFT, projectId: PROJECT, title: "Export feature" })),
      },
    } as unknown as CommandOptions["db"],
    tenantPolicy: loadTeamsTenantAllowlist({}),
    rateLimit: vi.fn(async () => ({ allowed: true, remaining: 29 })) as never,
    authorizeProject: vi.fn(async () => true) as never,
    approve: vi.fn(async () => ({ id: DRAFT }) as never),
    summarize: vi.fn(async () => ({
      projectId: PROJECT,
      name: "Apollo",
      status: "active",
      requirementCount: 10,
      drafts: { pending: 2, approved: 1, published: 5 },
      latestAnalysisStatus: "completed",
      latestPublishStatus: "running",
    })),
    ...over,
  };
}

beforeEach(() => vi.restoreAllMocks());

describe("command parsing", () => {
  it("recognises /metis as the leading token (case-insensitive)", () => {
    expect(isMetisCommandText("/metis status")).toBe(true);
    expect(isMetisCommandText("/METIS approve x")).toBe(true);
    expect(isMetisCommandText("hello world")).toBe(false);
  });

  it("strips the bot @mention before parsing", () => {
    const activity = {
      text: "<at>METIS</at> /metis status",
      recipient: { id: "28:bot" },
      entities: [{ type: "mention", text: "<at>METIS</at>", mentioned: { id: "28:bot" } }],
    };
    expect(stripBotMention(activity)).toBe("/metis status");
  });

  it("parses status with and without a project ref", () => {
    expect(parseMetisCommand("/metis status")).toEqual({ kind: "status", projectRef: null });
    expect(parseMetisCommand("/metis status proj-9")).toEqual({
      kind: "status",
      projectRef: "proj-9",
    });
  });

  it("parses approve with a draft ref", () => {
    expect(parseMetisCommand("/metis approve draft-7")).toEqual({
      kind: "approve",
      draftRef: "draft-7",
    });
  });

  it("returns help for a bare /metis and unknown for an unrecognised subcommand", () => {
    expect(parseMetisCommand("/metis")).toEqual({ kind: "help" });
    expect(parseMetisCommand("/metis frobnicate")).toEqual({ kind: "unknown", raw: "frobnicate" });
  });

  it("isApproveSubmit recognises the approve action value", () => {
    expect(
      isApproveSubmit({ type: "message", value: { metisAction: "approve", draftId: DRAFT } }),
    ).toBe(true);
    expect(isApproveSubmit({ type: "message", value: { metisAction: "promote" } })).toBe(false);
    expect(isApproveSubmit({ type: "invoke", value: { metisAction: "approve" } })).toBe(false);
  });
});

describe("/metis status", () => {
  it("shows a health card for an authorized member on the channel's linked project", async () => {
    const { context, sent } = makeContext({ text: "/metis status" });
    const opts = makeOpts();

    const res: CommandResult = await handleTeamsStatusCommand(context, { projectRef: null }, opts);

    expect(res.outcome).toBe("status-shown");
    expect(res.projectId).toBe(PROJECT);
    expect(opts.summarize).toHaveBeenCalledWith(PROJECT, expect.anything());
    const card = JSON.stringify(sent[0]);
    expect(card).toContain("Apollo");
    expect(card).toContain("Requirements");
  });

  it("uses an explicit project ref over the channel link", async () => {
    const { context } = makeContext({ text: "/metis status proj-explicit" });
    const opts = makeOpts();
    const res = await handleTeamsStatusCommand(context, { projectRef: "proj-explicit" }, opts);
    expect(res.outcome).toBe("status-shown");
    expect(opts.linkStore!.getByConversation).not.toHaveBeenCalled();
    expect(opts.summarize).toHaveBeenCalledWith("proj-explicit", expect.anything());
  });

  it("refuses when the channel is unlinked and no project ref is given", async () => {
    const { context, sent } = makeContext({ text: "/metis status" });
    const opts = makeOpts({
      linkStore: {
        getByConversation: vi.fn(async () => null),
      } as unknown as CommandOptions["linkStore"],
    });
    const res = await handleTeamsStatusCommand(context, { projectRef: null }, opts);
    expect(res.outcome).toBe("no-project");
    expect(opts.summarize).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
  });

  it("refuses a non-member (project access denied)", async () => {
    const { context } = makeContext({ text: "/metis status" });
    const opts = makeOpts({ authorizeProject: vi.fn(async () => false) as never });
    const res = await handleTeamsStatusCommand(context, { projectRef: null }, opts);
    expect(res.outcome).toBe("forbidden");
    expect(opts.summarize).not.toHaveBeenCalled();
  });

  it("reports project-not-found when summarize returns null", async () => {
    const { context } = makeContext({ text: "/metis status" });
    const opts = makeOpts({ summarize: vi.fn(async () => null) });
    const res = await handleTeamsStatusCommand(context, { projectRef: null }, opts);
    expect(res.outcome).toBe("project-not-found");
  });

  it("refuses an unmapped sender (resolver → null)", async () => {
    const { context, sent } = makeContext({ text: "/metis status" });
    const opts = makeOpts({
      resolver: {
        resolveUserFromAadObjectId: vi.fn(async () => null),
      } as unknown as CommandOptions["resolver"],
    });
    const res = await handleTeamsStatusCommand(context, { projectRef: null }, opts);
    expect(res.outcome).toBe("unmapped-sender");
    expect(JSON.stringify(sent[0]).toLowerCase()).toMatch(/link|account/);
  });

  it("refuses a non-allowlisted tenant before resolving the user", async () => {
    const { context } = makeContext({ text: "/metis status", tenantId: "tenant-evil" });
    const opts = makeOpts({
      tenantPolicy: loadTeamsTenantAllowlist({ TEAMS_ALLOWED_TENANTS: "tenant-1" }),
    });
    const res = await handleTeamsStatusCommand(context, { projectRef: null }, opts);
    expect(res.outcome).toBe("tenant-not-allowed");
    expect(opts.resolver!.resolveUserFromAadObjectId).not.toHaveBeenCalled();
  });

  it("is rate-limited when the inbound cap is exceeded", async () => {
    const { context } = makeContext({ text: "/metis status" });
    const opts = makeOpts({
      rateLimit: vi.fn(async () => ({ allowed: false, limit: 30, retryAfterMs: 1000 })) as never,
    });
    const res = await handleTeamsStatusCommand(context, { projectRef: null }, opts);
    expect(res.outcome).toBe("rate-limited");
    expect(opts.summarize).not.toHaveBeenCalled();
  });

  it("fails open on a rate-limit store error (still serves)", async () => {
    const { context } = makeContext({ text: "/metis status" });
    const opts = makeOpts({
      rateLimit: vi.fn(async () => {
        throw new Error("store down");
      }) as never,
    });
    const res = await handleTeamsStatusCommand(context, { projectRef: null }, opts);
    expect(res.outcome).toBe("status-shown");
  });
});

describe("/metis approve <draft> (prompt)", () => {
  it("posts an Approve Action.Submit card for an authorized member", async () => {
    const { context, sent } = makeContext({ text: "/metis approve draft-1" });
    const opts = makeOpts();
    const res = await handleTeamsApproveCommand(context, { draftRef: DRAFT }, opts);
    expect(res.outcome).toBe("approve-prompted");
    const card = JSON.stringify(sent[0]);
    expect(card).toContain("Action.Submit");
    expect(card).toContain("approve");
    expect(card).toContain(DRAFT);
    // The prompt does NOT approve yet.
    expect(opts.approve).not.toHaveBeenCalled();
  });

  it("refuses with bad-correlation when no draft ref is given", async () => {
    const { context } = makeContext({ text: "/metis approve" });
    const opts = makeOpts();
    const res = await handleTeamsApproveCommand(context, { draftRef: null }, opts);
    expect(res.outcome).toBe("bad-correlation");
  });

  it("refuses a role lacking issue.draft permission (reader)", async () => {
    const { context, sent } = makeContext({ text: "/metis approve draft-1" });
    const opts = makeOpts({ roleKey: "reader" });
    const res = await handleTeamsApproveCommand(context, { draftRef: DRAFT }, opts);
    expect(res.outcome).toBe("forbidden");
    expect(JSON.stringify(sent[0]).toLowerCase()).toMatch(/permission/);
  });

  it("reports draft-not-found if the draft vanishes between authz and the prompt reload", async () => {
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce({ id: DRAFT, projectId: PROJECT }) // authorizeDraftAccess
      .mockResolvedValueOnce(null); // prompt reload
    const opts = makeOpts({
      db: {
        userRole: { findFirst: vi.fn(async () => ({ role: { key: "coordinator" } })) },
        issueDraft: { findFirst },
      } as unknown as CommandOptions["db"],
    });
    const { context } = makeContext({ text: "/metis approve draft-1" });
    const res = await handleTeamsApproveCommand(context, { draftRef: DRAFT }, opts);
    expect(res.outcome).toBe("draft-not-found");
  });

  it("treats a missing draft and an inaccessible draft identically (no probing)", async () => {
    const missing = makeOpts({
      db: {
        userRole: { findFirst: vi.fn(async () => ({ role: { key: "coordinator" } })) },
        issueDraft: { findFirst: vi.fn(async () => null) },
      } as unknown as CommandOptions["db"],
    });
    const { context: c1 } = makeContext({ text: "/metis approve x" });
    const r1 = await handleTeamsApproveCommand(c1, { draftRef: "x" }, missing);
    expect(r1.outcome).toBe("draft-not-found");

    const inaccessible = makeOpts({ authorizeProject: vi.fn(async () => false) as never });
    const { context: c2, sent: s2 } = makeContext({ text: "/metis approve draft-1" });
    const r2 = await handleTeamsApproveCommand(c2, { draftRef: DRAFT }, inaccessible);
    expect(r2.outcome).toBe("draft-not-found");
    expect(inaccessible.approve).not.toHaveBeenCalled();
    expect(JSON.stringify(s2[0]).toLowerCase()).toContain("not be found");
  });
});

describe("Approve Action.Submit (the actual approval)", () => {
  it("invokes the approval service attributed to the resolved user + posts a confirmation", async () => {
    const { context, sent } = makeContext({
      value: { metisAction: "approve", draftId: DRAFT },
    });
    const opts = makeOpts();
    const res = await handleTeamsApproveSubmit(context, opts);
    expect(res.outcome).toBe("approved");
    expect(opts.approve).toHaveBeenCalledTimes(1);
    const arg = (opts.approve as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // #1072: ChatOps has no path project — it passes `projectId: null` because
    // authorizeDraftAccess already resolved and authorized the draft's own project.
    expect(arg).toEqual({ draftId: DRAFT, actorId: "user-1", projectId: null });
    expect(JSON.stringify(sent[0]).toLowerCase()).toContain("approved");
  });

  it("refuses bad-correlation when the submit value omits draftId", async () => {
    const { context } = makeContext({ value: { metisAction: "approve" } });
    const opts = makeOpts();
    const res = await handleTeamsApproveSubmit(context, opts);
    expect(res.outcome).toBe("bad-correlation");
    expect(opts.approve).not.toHaveBeenCalled();
  });

  it("re-runs authz on the click: refuses an unmapped sender", async () => {
    const { context } = makeContext({ value: { metisAction: "approve", draftId: DRAFT } });
    const opts = makeOpts({
      resolver: {
        resolveUserFromAadObjectId: vi.fn(async () => null),
      } as unknown as CommandOptions["resolver"],
    });
    const res = await handleTeamsApproveSubmit(context, opts);
    expect(res.outcome).toBe("unmapped-sender");
    expect(opts.approve).not.toHaveBeenCalled();
  });

  it("re-runs authz on the click: refuses a non-allowlisted tenant", async () => {
    const { context } = makeContext({
      value: { metisAction: "approve", draftId: DRAFT },
      tenantId: "tenant-evil",
    });
    const opts = makeOpts({
      tenantPolicy: loadTeamsTenantAllowlist({ TEAMS_ALLOWED_TENANTS: "tenant-1" }),
    });
    const res = await handleTeamsApproveSubmit(context, opts);
    expect(res.outcome).toBe("tenant-not-allowed");
    expect(opts.approve).not.toHaveBeenCalled();
  });

  it("re-runs authz on the click: refuses a role lacking issue.draft", async () => {
    const { context } = makeContext({ value: { metisAction: "approve", draftId: DRAFT } });
    const opts = makeOpts({ roleKey: "reader" });
    const res = await handleTeamsApproveSubmit(context, opts);
    expect(res.outcome).toBe("forbidden");
    expect(opts.approve).not.toHaveBeenCalled();
  });

  it("returns draft-not-found (no partial state) when the service throws DRAFT_NOT_FOUND", async () => {
    const { context, sent } = makeContext({ value: { metisAction: "approve", draftId: DRAFT } });
    const opts = makeOpts({
      approve: vi.fn(async () => {
        throw new PublishError(404, "DRAFT_NOT_FOUND", "draft not found");
      }) as never,
    });
    const res = await handleTeamsApproveSubmit(context, opts);
    expect(res.outcome).toBe("draft-not-found");
    expect(JSON.stringify(sent[0]).toLowerCase()).toContain("not be found");
  });

  it("returns approve-failed with a safe card (no leak) on an unexpected error", async () => {
    const { context, sent } = makeContext({ value: { metisAction: "approve", draftId: DRAFT } });
    const opts = makeOpts({
      approve: vi.fn(async () => {
        throw new Error("db exploded");
      }) as never,
    });
    const res = await handleTeamsApproveSubmit(context, opts);
    expect(res.outcome).toBe("approve-failed");
    expect(JSON.stringify(sent[0])).not.toContain("db exploded");
  });

  it("never throws even if the confirmation card send fails", async () => {
    const { context } = makeContext({ value: { metisAction: "approve", draftId: DRAFT } });
    (context.sendActivity as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("channel gone"));
    const opts = makeOpts();
    const res = await handleTeamsApproveSubmit(context, opts);
    expect(res.outcome).toBe("approved");
  });

  it("defaults an actor with no assigned role to least-privilege (refused)", async () => {
    const { context } = makeContext({ value: { metisAction: "approve", draftId: DRAFT } });
    const opts = makeOpts({
      db: {
        userRole: { findFirst: vi.fn(async () => null) },
        issueDraft: {
          findFirst: vi.fn(async () => ({ id: DRAFT, projectId: PROJECT, title: "x" })),
        },
      } as unknown as CommandOptions["db"],
    });
    const res = await handleTeamsApproveSubmit(context, opts);
    expect(res.outcome).toBe("forbidden");
    expect(opts.approve).not.toHaveBeenCalled();
  });
});
