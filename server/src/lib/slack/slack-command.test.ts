/**
 * Issue #579 — Slack ChatOps command + interactive-approval tests.
 *
 * Covers the full security matrix with stubbed collaborators (no Bolt, no DB):
 *   - parsing (status/approve/help/unknown);
 *   - `/metis status` by a mapped, authorized member → health blocks (ephemeral);
 *   - `/metis approve` → an Approve-button prompt (ephemeral);
 *   - the Approve action by an authorized member → `approveDraft` with the
 *     RESOLVED actorId + an in-channel confirmation;
 *   - unmapped Slack user → refused (never approves);
 *   - unauthorized role → refused;
 *   - inaccessible project draft → SAME refusal as not-found (no probing);
 *   - bad/missing draft id → graceful error;
 *   - approval-service failure → safe error, no partial state.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PublishError } from "../publishing/types.js";
import type { ProjectHealthSummary } from "../teams/project-health.js";
import { APPROVE_ACTION_ID } from "./block-kit.js";
import {
  handleSlackApproveAction,
  handleSlackApproveCommand,
  handleSlackCommand,
  handleSlackStatusCommand,
  parseSlackCommand,
  type SlackActorContext,
  type SlackCommandOptions,
} from "./slack-command.js";

const ACTOR: SlackActorContext = {
  workspaceId: "ws-1",
  slackTeamId: "T1",
  slackUserId: "U1",
};

const HEALTH: ProjectHealthSummary = {
  projectId: "proj-1",
  name: "Acme Project",
  status: "active",
  requirementCount: 12,
  drafts: { pending: 2, approved: 1, published: 5 },
  latestAnalysisStatus: "completed",
  latestPublishStatus: "succeeded",
};

/** Build a fake Prisma surface used by the handlers. */
function fakeDb(opts: {
  role?: string | null;
  draft?: { id: string; projectId: string; title: string } | null;
}) {
  return {
    userRole: {
      findFirst: vi.fn(async () =>
        opts.role === undefined
          ? { role: { key: "coordinator" } }
          : opts.role === null
            ? null
            : { role: { key: opts.role } },
      ),
    },
    issueDraft: {
      findFirst: vi.fn(async () => opts.draft ?? null),
    },
  } as unknown as SlackCommandOptions["db"];
}

/** A resolver stub that maps U1 → u-1 (or returns null for "unmapped"). */
function resolver(mapped: boolean) {
  return {
    resolveUserFromSlackId: vi.fn(async () =>
      mapped ? { userId: "u-1", username: "alice", email: "a@b.com" } : null,
    ),
  } as unknown as SlackCommandOptions["resolver"];
}

describe("parseSlackCommand (#579)", () => {
  it("parses status with and without a project ref", () => {
    expect(parseSlackCommand("status")).toEqual({ kind: "status", projectRef: null });
    expect(parseSlackCommand("status proj-1")).toEqual({ kind: "status", projectRef: "proj-1" });
  });
  it("parses approve with a draft ref", () => {
    expect(parseSlackCommand("approve draft-1")).toEqual({ kind: "approve", draftRef: "draft-1" });
  });
  it("empty text is help; unknown subcommand is unknown", () => {
    expect(parseSlackCommand("")).toEqual({ kind: "help" });
    expect(parseSlackCommand("   ")).toEqual({ kind: "help" });
    expect(parseSlackCommand("frobnicate")).toEqual({ kind: "unknown", raw: "frobnicate" });
  });
  it("length-bounds untrusted refs", () => {
    const parsed = parseSlackCommand(`status ${"x".repeat(500)}`);
    expect(parsed.kind).toBe("status");
    if (parsed.kind === "status") expect(parsed.projectRef?.length).toBe(200);
  });
});

describe("/metis status (#579)", () => {
  let summarize: ReturnType<typeof vi.fn>;
  let authorizeProject: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    summarize = vi.fn(async () => HEALTH);
    authorizeProject = vi.fn(async () => true);
  });

  it("shows ephemeral health for a mapped, authorized member", async () => {
    const reply = await handleSlackStatusCommand(
      ACTOR,
      { projectRef: "proj-1" },
      {
        resolver: resolver(true),
        db: fakeDb({}),
        authorizeProject: authorizeProject as never,
        summarize: summarize as never,
      },
    );
    expect(reply.outcome).toBe("status-shown");
    expect(reply.responseType).toBe("ephemeral");
    expect(JSON.stringify(reply.blocks)).toContain("Acme Project");
    expect(summarize).toHaveBeenCalledWith("proj-1", expect.anything());
  });

  it("refuses an unmapped Slack user", async () => {
    const reply = await handleSlackStatusCommand(
      ACTOR,
      { projectRef: "proj-1" },
      {
        resolver: resolver(false),
        db: fakeDb({}),
        authorizeProject: authorizeProject as never,
        summarize: summarize as never,
      },
    );
    expect(reply.outcome).toBe("unmapped-sender");
    expect(authorizeProject).not.toHaveBeenCalled();
    expect(summarize).not.toHaveBeenCalled();
  });

  it("refuses when the member lacks project access", async () => {
    authorizeProject.mockResolvedValue(false);
    const reply = await handleSlackStatusCommand(
      ACTOR,
      { projectRef: "proj-1" },
      {
        resolver: resolver(true),
        db: fakeDb({}),
        authorizeProject: authorizeProject as never,
        summarize: summarize as never,
      },
    );
    expect(reply.outcome).toBe("forbidden");
    expect(summarize).not.toHaveBeenCalled();
  });

  it("uses the install default project when no ref is given", async () => {
    const reply = await handleSlackStatusCommand(
      { ...ACTOR, defaultProjectId: "proj-default" },
      { projectRef: null },
      {
        resolver: resolver(true),
        db: fakeDb({}),
        authorizeProject: authorizeProject as never,
        summarize: summarize as never,
      },
    );
    expect(reply.outcome).toBe("status-shown");
    expect(summarize).toHaveBeenCalledWith("proj-default", expect.anything());
  });

  it("asks for a project when none is given and no default exists", async () => {
    const reply = await handleSlackStatusCommand(
      ACTOR,
      { projectRef: null },
      {
        resolver: resolver(true),
        db: fakeDb({}),
        authorizeProject: authorizeProject as never,
        summarize: summarize as never,
      },
    );
    expect(reply.outcome).toBe("no-project");
  });

  it("gracefully reports a vanished project", async () => {
    summarize.mockResolvedValue(null);
    const reply = await handleSlackStatusCommand(
      ACTOR,
      { projectRef: "proj-gone" },
      {
        resolver: resolver(true),
        db: fakeDb({}),
        authorizeProject: authorizeProject as never,
        summarize: summarize as never,
      },
    );
    expect(reply.outcome).toBe("project-not-found");
  });
});

describe("/metis approve prompt (#579)", () => {
  it("returns an Approve-button prompt for an authorized member", async () => {
    const reply = await handleSlackApproveCommand(
      ACTOR,
      { draftRef: "draft-1" },
      {
        resolver: resolver(true),
        db: fakeDb({
          role: "coordinator",
          draft: { id: "draft-1", projectId: "proj-1", title: "Add login" },
        }),
        authorizeProject: (async () => true) as never,
      },
    );
    expect(reply.outcome).toBe("approve-prompted");
    expect(reply.responseType).toBe("ephemeral");
    expect(JSON.stringify(reply.blocks)).toContain(APPROVE_ACTION_ID);
    expect(JSON.stringify(reply.blocks)).toContain("draft-1");
  });

  it("requires a draft id", async () => {
    const reply = await handleSlackApproveCommand(
      ACTOR,
      { draftRef: null },
      { resolver: resolver(true), db: fakeDb({ role: "coordinator" }) },
    );
    expect(reply.outcome).toBe("bad-correlation");
  });

  it("refuses a member without the issue.draft permission (reader role)", async () => {
    const reply = await handleSlackApproveCommand(
      ACTOR,
      { draftRef: "draft-1" },
      {
        resolver: resolver(true),
        db: fakeDb({ role: "reader", draft: { id: "draft-1", projectId: "proj-1", title: "x" } }),
      },
    );
    expect(reply.outcome).toBe("forbidden");
  });

  it("treats an inaccessible-project draft identically to not-found (no probing)", async () => {
    const reply = await handleSlackApproveCommand(
      ACTOR,
      { draftRef: "draft-1" },
      {
        resolver: resolver(true),
        db: fakeDb({
          role: "coordinator",
          draft: { id: "draft-1", projectId: "other-proj", title: "x" },
        }),
        authorizeProject: (async () => false) as never,
      },
    );
    expect(reply.outcome).toBe("draft-not-found");
  });

  it("reports a genuinely missing draft as not-found", async () => {
    const reply = await handleSlackApproveCommand(
      ACTOR,
      { draftRef: "ghost" },
      { resolver: resolver(true), db: fakeDb({ role: "coordinator", draft: null }) },
    );
    expect(reply.outcome).toBe("draft-not-found");
  });
});

describe("Approve button action (#579)", () => {
  it("approves via approveDraft with the RESOLVED actorId + in-channel confirmation", async () => {
    const approve = vi.fn(async () => ({}) as never);
    const reply = await handleSlackApproveAction(
      ACTOR,
      { draftId: "draft-1" },
      {
        resolver: resolver(true),
        db: fakeDb({
          role: "coordinator",
          draft: { id: "draft-1", projectId: "proj-1", title: "x" },
        }),
        authorizeProject: (async () => true) as never,
        approve: approve as never,
      },
    );
    expect(reply.outcome).toBe("approved");
    expect(reply.responseType).toBe("in_channel");
    // #1072: ChatOps has no path project — it passes `projectId: null` because
    // authorizeDraftAccess already resolved and authorized the draft's own project.
    expect(approve).toHaveBeenCalledWith({
      draftId: "draft-1",
      actorId: "u-1",
      projectId: null,
    });
  });

  it("refuses an unmapped user — never approves", async () => {
    const approve = vi.fn(async () => ({}) as never);
    const reply = await handleSlackApproveAction(
      ACTOR,
      { draftId: "draft-1" },
      { resolver: resolver(false), db: fakeDb({}), approve: approve as never },
    );
    expect(reply.outcome).toBe("unmapped-sender");
    expect(approve).not.toHaveBeenCalled();
  });

  it("refuses an unauthorized role — never approves", async () => {
    const approve = vi.fn(async () => ({}) as never);
    const reply = await handleSlackApproveAction(
      ACTOR,
      { draftId: "draft-1" },
      {
        resolver: resolver(true),
        db: fakeDb({ role: "reader", draft: { id: "draft-1", projectId: "proj-1", title: "x" } }),
        approve: approve as never,
      },
    );
    expect(reply.outcome).toBe("forbidden");
    expect(approve).not.toHaveBeenCalled();
  });

  it("handles a missing draft id in the action value", async () => {
    const reply = await handleSlackApproveAction(
      ACTOR,
      { draftId: null },
      { resolver: resolver(true), db: fakeDb({ role: "coordinator" }) },
    );
    expect(reply.outcome).toBe("bad-correlation");
  });

  it("maps a DRAFT_NOT_FOUND PublishError to a safe not-found reply", async () => {
    const approve = vi.fn(async () => {
      throw new PublishError(404, "DRAFT_NOT_FOUND", "draft not found");
    });
    const reply = await handleSlackApproveAction(
      ACTOR,
      { draftId: "draft-1" },
      {
        resolver: resolver(true),
        db: fakeDb({
          role: "coordinator",
          draft: { id: "draft-1", projectId: "proj-1", title: "x" },
        }),
        authorizeProject: (async () => true) as never,
        approve: approve as never,
      },
    );
    expect(reply.outcome).toBe("draft-not-found");
  });

  it("surfaces a safe error (no leak) when the approval service throws unexpectedly", async () => {
    const approve = vi.fn(async () => {
      throw new Error("internal DB exploded with secret=hunter2");
    });
    const reply = await handleSlackApproveAction(
      ACTOR,
      { draftId: "draft-1" },
      {
        resolver: resolver(true),
        db: fakeDb({
          role: "coordinator",
          draft: { id: "draft-1", projectId: "proj-1", title: "x" },
        }),
        authorizeProject: (async () => true) as never,
        approve: approve as never,
      },
    );
    expect(reply.outcome).toBe("approve-failed");
    expect(JSON.stringify(reply.blocks)).not.toContain("hunter2");
  });
});

describe("handleSlackCommand dispatch (#579)", () => {
  it("routes help, unknown, status and approve", async () => {
    const opts: SlackCommandOptions = {
      resolver: resolver(true),
      db: fakeDb({ role: "coordinator", draft: { id: "d", projectId: "proj-1", title: "x" } }),
      authorizeProject: (async () => true) as never,
      summarize: (async () => HEALTH) as never,
    };
    expect((await handleSlackCommand(ACTOR, "", opts)).outcome).toBe("help");
    expect((await handleSlackCommand(ACTOR, "wat", opts)).outcome).toBe("unknown-command");
    expect((await handleSlackCommand(ACTOR, "status proj-1", opts)).outcome).toBe("status-shown");
    expect((await handleSlackCommand(ACTOR, "approve d", opts)).outcome).toBe("approve-prompted");
  });
});
