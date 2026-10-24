/**
 * #1005 — a custom agent turned OFF for a project is never offered to that
 * project's chat (the model's sub-agent tools and the session agent picker),
 * a session bound to it fails closed, a delegation to it that was offered
 * before it was turned off is refused BEFORE anyone is asked to approve it
 * (no two-minute approval wait), and turning it back on restores all of it.
 *
 * The rule (#1445): off until enabled. Only an enabled row for (agent,
 * project) makes it usable — owning it does not. The authoring playground is
 * the one exception (`customAgentPlaygroundAccess`, its route only).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

const rows = vi.hoisted(() => ({
  custom: [] as Array<Record<string, unknown>>,
  enablement: [] as Array<{ customAgentId: string; projectId: string; enabled: boolean }>,
  /** Every enablement read fails (the database is unreachable). */
  enablementReadsFail: false,
  /** #1500 — each project's workspace (absent: none). */
  projectWorkspace: {} as Record<string, string | null>,
}));

interface Where {
  projectId?: string;
  enabled?: boolean;
  id?: string | { in: string[] };
  OR?: Where[];
  customAgentId_projectId?: { customAgentId: string; projectId: string };
}

function matches(r: Record<string, unknown>, w: Where): boolean {
  if (w.OR && !w.OR.some((c) => matches(r, c))) return false;
  if ("projectId" in w && r.projectId !== w.projectId) return false;
  if ("enabled" in w && r.enabled !== w.enabled) return false;
  if (typeof w.id === "string" && r.id !== w.id) return false;
  if (w.id && typeof w.id === "object" && !w.id.in.includes(r.id as string)) return false;
  return true;
}

const fakeDb = vi.hoisted(() => ({}) as Record<string, unknown>);
Object.assign(fakeDb, {
  customAgent: {
    findUnique: vi.fn(
      async ({ where }: { where: { id: string } }) =>
        rows.custom.find((r) => r.id === where.id) ?? null,
    ),
    findMany: vi.fn(async ({ where }: { where: Where }) =>
      rows.custom.filter((r) => matches(r, where)),
    ),
  },
  customAgentEnablement: {
    findUnique: vi.fn(async ({ where }: { where: Where }) => {
      const k = where.customAgentId_projectId!;
      return (
        rows.enablement.find(
          (e) => e.customAgentId === k.customAgentId && e.projectId === k.projectId,
        ) ?? null
      );
    }),
    findMany: vi.fn(async ({ where }: { where: Where }) => {
      if (rows.enablementReadsFail) throw new Error("db unreachable");
      return rows.enablement.filter((e) => matches(e as unknown as Record<string, unknown>, where));
    }),
  },
  project: {
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
      where.id in rows.projectWorkspace
        ? { workspaceId: rows.projectWorkspace[where.id] ?? null }
        : null,
    ),
  },
  projectAgentAllowlist: { findMany: vi.fn(async () => []) },
  agent: { findMany: vi.fn(async () => []), findUnique: vi.fn(async () => null) },
  skill: { findMany: vi.fn(async () => []) },
  aIToolApproval: { create: vi.fn(async () => ({})), findFirst: vi.fn(async () => null) },
});

vi.mock("../prisma.js", () => ({ prisma: fakeDb }));
vi.mock("../audit/audit-service.js", () => ({ audit: vi.fn() }));

import {
  customAgentPlaygroundAccess,
  customAgentPlaygroundAccessFor,
  customAgentUsableInProject,
  isAgentCallable,
  isCustomAgentUsableInProject,
  listCallableAgents,
  loadAgentDefinition,
} from "./definition.js";
import { listBindableAgents, loadBoundCustomAgent, sessionAgentNotice } from "./session-agent.js";
import { SubAgentBudget, subAgentTools, type AgentToolsContext } from "./subagents.js";
import { ApprovalGateService } from "../ai/approval-policy.js";
import { executeToolCall } from "../ai/tool-runtime/executor.js";
import { makeToolset } from "../ai/tool-runtime/toolset.js";
import type { AIProvider } from "../ai/types.js";
import { listEnabledAgentsForProject } from "../custom-agents/index.js";
import { listAnalysisPhaseAgents } from "../analysis/custom-agent-phase.js";

const db = fakeDb as unknown as PrismaClient;

function agentRow(id: string, projectId: string | null, name = `Agent ${id}`) {
  return {
    id,
    projectId,
    name,
    description: "",
    systemPrompt: "",
    tools: "[]",
    model: null,
    reasoningEffort: null,
    skillKeys: "[]",
    approvalPolicy: null,
    version: "1.0.0",
    isBuiltIn: false,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

function setEnabled(customAgentId: string, projectId: string, enabled: boolean): void {
  const row = rows.enablement.find(
    (e) => e.customAgentId === customAgentId && e.projectId === projectId,
  );
  if (row) row.enabled = enabled;
  else rows.enablement.push({ customAgentId, projectId, enabled });
}

beforeEach(() => {
  rows.enablementReadsFail = false;
  rows.projectWorkspace = { p1: "w1" };
  rows.custom.length = 0;
  rows.enablement.length = 0;
  rows.custom.push(
    agentRow("own", "p1", "Go SQL reviewer"),
    agentRow("own2", "p1", "Helper"),
    agentRow("shared", null, "Shared"),
    agentRow("foreign", "p2", "Foreign"),
  );
  // The project's own agents start switched ON here; the #1445 block below
  // covers the never-switched case.
  setEnabled("own", "p1", true);
  setEnabled("own2", "p1", true);
});

/** Drop every enablement row: each owned agent is now "never toggled". */
function neverToggled(): void {
  rows.enablement.length = 0;
}

describe("customAgentUsableInProject — the one rule (#1445: off until enabled)", () => {
  it("only an enabled row makes an agent usable; no row is off", () => {
    expect(customAgentUsableInProject(null)).toBe(false);
    expect(customAgentUsableInProject(undefined)).toBe(false);
    expect(customAgentUsableInProject({ enabled: false })).toBe(false);
    expect(customAgentUsableInProject({ enabled: true })).toBe(true);
  });
});

describe("customAgentPlaygroundAccess — the playground's exception", () => {
  it("the owner's admin may test a never-switched agent; a member may not; a row still decides", () => {
    expect(customAgentPlaygroundAccess("p1", "p1", null, true)).toBe("run");
    expect(customAgentPlaygroundAccess("p1", "p1", null, false)).toBe("off-until-enabled");
    expect(customAgentPlaygroundAccess("p1", "p1", { enabled: false }, true)).toBe("switched-off");
    expect(customAgentPlaygroundAccess("p1", "p1", { enabled: true }, false)).toBe("run");
    expect(customAgentPlaygroundAccess(null, "p1", null, true)).toBe("not-found");
    expect(customAgentPlaygroundAccess("p2", "p1", null, true)).toBe("not-found");
    expect(customAgentPlaygroundAccess(null, "p1", { enabled: true }, false)).toBe("run");
    expect(customAgentPlaygroundAccess("p2", "p1", { enabled: false }, true)).toBe("not-found");
  });
});

describe("isCustomAgentUsableInProject", () => {
  const own = { kind: "custom" as const, id: "own", projectId: "p1" };

  it("refuses an agent the project OWNS once it is turned off for the project", async () => {
    setEnabled("own", "p1", false);
    expect(await isCustomAgentUsableInProject(own, "p1", db)).toBe(false);
  });

  it("turning an owned agent back on restores it", async () => {
    expect(await isCustomAgentUsableInProject(own, "p1", db)).toBe(true);
    setEnabled("own", "p1", false);
    setEnabled("own", "p1", true);
    expect(await isCustomAgentUsableInProject(own, "p1", db)).toBe(true);
  });

  it("another project's agent needs an enabled row; a library ref is never custom-usable", async () => {
    const shared = { kind: "custom" as const, id: "shared", projectId: null };
    expect(await isCustomAgentUsableInProject(shared, "p1", db)).toBe(false);
    setEnabled("shared", "p1", true);
    expect(await isCustomAgentUsableInProject(shared, "p1", db)).toBe(true);
    expect(
      await isCustomAgentUsableInProject({ kind: "library", id: "x", projectId: null }, "p1", db),
    ).toBe(false);
  });
});

describe("the offer: chat's sub-agent tools and the session agent picker", () => {
  const callableRefs = async () => (await listCallableAgents("p1", { db })).map((d) => d.ref);
  const bindableRefs = async () =>
    (await listBindableAgents("p1", db)).filter((a) => a.kind === "custom").map((a) => a.ref);

  it("an owned agent turned off for the project is offered to neither", async () => {
    setEnabled("own", "p1", false);
    expect(await callableRefs()).not.toContain("custom:own");
    expect(await bindableRefs()).not.toContain("custom:own");
    // The project's other agents are unaffected.
    expect(await callableRefs()).toContain("custom:own2");
    expect(await bindableRefs()).toContain("custom:own2");
  });

  it("turning it back on offers it again", async () => {
    setEnabled("own", "p1", false);
    setEnabled("own", "p1", true);
    expect(await callableRefs()).toContain("custom:own");
    expect(await bindableRefs()).toContain("custom:own");
  });

  it("a shared agent is offered only while enabled, and never another project's own agent", async () => {
    expect(await callableRefs()).not.toContain("custom:shared");
    setEnabled("shared", "p1", true);
    expect(await callableRefs()).toContain("custom:shared");
    expect(await bindableRefs()).toContain("custom:shared");
    setEnabled("shared", "p1", false);
    expect(await callableRefs()).not.toContain("custom:shared");
    expect(await callableRefs()).not.toContain("custom:foreign");
    // Turned off for ANOTHER project: still offered here.
    setEnabled("own", "p2", false);
    expect(await callableRefs()).toContain("custom:own");
  });

  it("a session bound to an agent that was turned off fails closed", async () => {
    setEnabled("own", "p1", false);
    expect(await loadBoundCustomAgent("custom:own", "p1", db)).toBeNull();
    setEnabled("own", "p1", true);
    expect((await loadBoundCustomAgent("custom:own", "p1", db))?.ref).toBe("custom:own");
  });
});

describe("a delegation offered before the agent was turned off", () => {
  async function offeredTool() {
    const def = (await loadAgentDefinition("custom:own", db))!;
    const ctx: AgentToolsContext = {
      provider: { key: "offline-stub" } as unknown as AIProvider,
      model: "m",
      session: { id: "s1", userId: "u1", projectId: "p1" },
      callable: [def],
      limits: { maxDepth: 2, tokenBudget: 1000, maxTurns: 6 },
      budget: new SubAgentBudget(1000),
      db,
      isCallable: (ref) => isAgentCallable("p1", ref, db),
    };
    const [tool] = subAgentTools(
      ctx,
      {
        depth: 0,
        runId: null,
        allowlist: null,
        baseToolset: makeToolset([]),
        policy: { low: "always-prompt", medium: "always-prompt", high: "always-prompt" },
      },
      new Set(),
    );
    return tool!;
  }

  it("is refused at once, before anyone is asked to approve it, in words an analyst reads", async () => {
    const tool = await offeredTool();
    setEnabled("own", "p1", false); // turned off mid-turn, after the offer was built
    // A prompter nobody answers: reaching it is the two-minute stall of #1005.
    const ask = vi.fn(() => new Promise<never>(() => {}));
    const gate = new ApprovalGateService({
      sessionId: "s1",
      userId: "u1",
      policy: { low: "always-prompt", medium: "always-prompt", high: "always-prompt" },
      prompter: { ask },
    });
    const execute = vi.spyOn(tool, "execute");
    const out = await executeToolCall(
      { id: "call_1", name: tool.wireName, args: { task: "review the SQL" } },
      {
        toolset: makeToolset([tool]),
        gate,
        ctx: { sessionId: "s1", userId: "u1", projectId: "p1" },
      },
    );
    expect(ask).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(out).toMatchObject({ isError: true, executed: false, errorCode: "TOOL_UNAVAILABLE" });
    expect(out.text).toContain('"Go SQL reviewer" agent is turned off for this project');
  });

  it("an agent still on goes to the approval gate as before", async () => {
    const tool = await offeredTool();
    const ask = vi.fn(async () => "deny" as const);
    const gate = new ApprovalGateService({
      sessionId: "s1",
      userId: "u1",
      policy: { low: "always-prompt", medium: "always-prompt", high: "always-prompt" },
      prompter: { ask },
    });
    const out = await executeToolCall(
      { id: "call_1", name: tool.wireName, args: { task: "review the SQL" } },
      {
        toolset: makeToolset([tool]),
        gate,
        ctx: { sessionId: "s1", userId: "u1", projectId: "p1" },
      },
    );
    expect(ask).toHaveBeenCalledTimes(1);
    expect(out.errorCode).toBe("TOOL_DENIED");
  });

  const gateThatApproves = () => {
    const ask = vi.fn(async () => "approve" as const);
    const gate = new ApprovalGateService({
      sessionId: "s1",
      userId: "u1",
      policy: { low: "always-prompt", medium: "always-prompt", high: "always-prompt" },
      prompter: { ask },
    });
    return { ask, gate };
  };
  const call = (tool: Awaited<ReturnType<typeof offeredTool>>, gate: ApprovalGateService) =>
    executeToolCall(
      { id: "call_1", name: tool.wireName, args: { task: "review the SQL" } },
      {
        toolset: makeToolset([tool]),
        gate,
        ctx: { sessionId: "s1", userId: "u1", projectId: "p1" },
      },
    );

  it("an agent DELETED since the offer is refused at once too, and the model is told it is gone, not turned off", async () => {
    const tool = await offeredTool();
    rows.custom.splice(
      rows.custom.findIndex((r) => r.id === "own"),
      1,
    );
    const { ask, gate } = gateThatApproves();
    const out = await call(tool, gate);
    expect(ask).not.toHaveBeenCalled();
    expect(out).toMatchObject({ executed: false, errorCode: "TOOL_UNAVAILABLE" });
    expect(out.text).toContain('"Go SQL reviewer" agent is no longer available');
    expect(out.text).not.toContain("turned off");
  });

  it("a check that cannot be READ is never reported as 'turned off': the gate decides, and the run says the check failed", async () => {
    const tool = await offeredTool();
    rows.enablementReadsFail = true;
    // The re-check itself rejects; it does not resolve `false`.
    await expect(isAgentCallable("p1", "custom:own", db)).rejects.toThrow("db unreachable");
    const { ask, gate } = gateThatApproves();
    const out = await call(tool, gate);
    // Left to the gate (not refused as unavailable)…
    expect(ask).toHaveBeenCalledTimes(1);
    expect(out.errorCode).not.toBe("TOOL_UNAVAILABLE");
    // …and the run itself does not start, saying why in accurate words.
    expect(out).toMatchObject({ executed: true, isError: true });
    expect(out.text).toContain('could not check whether the "Go SQL reviewer" agent may run');
    expect(out.text).not.toContain("turned off");
  });
});

describe("#1445 — an owned agent nobody has switched is off everywhere but the playground", () => {
  const own = { kind: "custom" as const, id: "own", projectId: "p1" };
  const callableRefs = async () => (await listCallableAgents("p1", { db })).map((d) => d.ref);
  const bindableRefs = async () =>
    (await listBindableAgents("p1", db)).filter((a) => a.kind === "custom").map((a) => a.ref);

  it("is not usable by the project that owns it", async () => {
    neverToggled();
    expect(await isCustomAgentUsableInProject(own, "p1", db)).toBe(false);
  });

  it("is offered neither as a chat sub-agent nor in the session agent picker", async () => {
    neverToggled();
    expect(await callableRefs()).toEqual([]);
    expect(await bindableRefs()).toEqual([]);
    expect(await isAgentCallable("p1", "custom:own", db)).toBe(false);
  });

  it("a session bound to it fails closed", async () => {
    neverToggled();
    expect(await loadBoundCustomAgent("custom:own", "p1", db)).toBeNull();
  });

  it("a session bound to it gets a notice naming the agent; none once it is enabled", async () => {
    const bound = { agentRef: "custom:own", projectId: "p1" };
    neverToggled();
    // #1500 — nobody ever enabled it: "off until enabled", not "switched off".
    expect(await sessionAgentNotice(bound, db)).toBe(
      'This chat\'s agent "Go SQL reviewer" is off for this project until it is enabled, so the chat runs without its persona, tools and skills. Ask a workspace admin to enable it under Custom agents.',
    );
    setEnabled("own", "p1", true);
    expect(await sessionAgentNotice(bound, db)).toBeNull();
    // #1500 — someone switched it off: said so.
    setEnabled("own", "p1", false);
    expect(await sessionAgentNotice(bound, db)).toBe(
      'This chat\'s agent "Go SQL reviewer" is switched off for this project, so the chat runs without its persona, tools and skills. Ask a workspace admin to switch it back on under Custom agents.',
    );
    // #1500 — a project with no workspace: only a system admin can enable it.
    rows.projectWorkspace = { p1: null };
    expect(await sessionAgentNotice(bound, db)).toMatch(/Ask a system admin to switch it back on/);
    neverToggled();
    expect(await sessionAgentNotice(bound, db)).toMatch(/Ask a system admin to enable it/);
    // Deleted: said so, without claiming it is switched off.
    expect(await sessionAgentNotice({ agentRef: "custom:gone", projectId: "p1" }, db)).toMatch(
      /^This chat's agent no longer exists/,
    );
    // No custom agent, or no project: nothing to say.
    expect(await sessionAgentNotice({ agentRef: null, projectId: "p1" }, db)).toBeNull();
    expect(await sessionAgentNotice({ agentRef: "library:x", projectId: "p1" }, db)).toBeNull();
    expect(await sessionAgentNotice({ agentRef: "custom:own", projectId: null }, db)).toBeNull();
  });

  it("enabling it offers it in chat and the picker", async () => {
    neverToggled();
    setEnabled("own", "p1", true);
    expect(await callableRefs()).toEqual(["custom:own"]);
    expect(await bindableRefs()).toEqual(["custom:own"]);
  });

  it("the analysis phase does not run it", async () => {
    neverToggled();
    expect((await listAnalysisPhaseAgents("p1")).map((d) => d.ref)).toEqual([]);
    setEnabled("own", "p1", true);
    expect((await listAnalysisPhaseAgents("p1")).map((d) => d.ref)).toEqual(["custom:own"]);
  });

  it("the card's list (enabled for the project) and chat's offer agree, before and after enabling", async () => {
    const cardIds = async () => (await listEnabledAgentsForProject("p1")).map((a) => a.id).sort();
    const chatIds = async () =>
      (await listCallableAgents("p1", { db })).map((d) => d.ref.replace(/^custom:/, "")).sort();
    neverToggled();
    expect(await cardIds()).toEqual([]);
    expect(await chatIds()).toEqual(await cardIds());
    setEnabled("own", "p1", true);
    expect(await cardIds()).toEqual(["own"]);
    expect(await chatIds()).toEqual(await cardIds());
  });

  it("the authoring playground may still run it, for its owner's admin only", async () => {
    neverToggled();
    const admin = vi.fn(async () => true);
    const member = vi.fn(async () => false);
    expect(await customAgentPlaygroundAccessFor(own, "p1", admin, db)).toBe("run");
    expect(await customAgentPlaygroundAccessFor(own, "p1", member, db)).toBe("off-until-enabled");
    // Another project gets nothing from ownership it does not have, admin or not.
    expect(await customAgentPlaygroundAccessFor(own, "p2", admin, db)).toBe("not-found");
    // Switched OFF by its owner: the playground honours that too.
    setEnabled("own", "p1", false);
    expect(await customAgentPlaygroundAccessFor(own, "p1", admin, db)).toBe("switched-off");
    expect(
      await customAgentPlaygroundAccessFor(
        { kind: "library", id: "x", projectId: null },
        "p1",
        admin,
        db,
      ),
    ).toBe("not-found");
  });

  it("the caller is asked only when it decides the answer", async () => {
    const asked = vi.fn(async () => true);
    // Enabled: decided by the row.
    expect(await customAgentPlaygroundAccessFor(own, "p1", asked, db)).toBe("run");
    expect(asked).not.toHaveBeenCalled();
  });
});
