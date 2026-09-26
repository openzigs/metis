/**
 * Epic #129 (#147), review + adversarial panel of PR #239 — how many callable
 * agents one caller is offered as tools.
 *
 *   • `listCallableAgents` returns EVERY agent the project may call: capping
 *     the whole project's list before a caller's allowlist narrowed it dropped
 *     an explicitly allowed agent that happened to sort 17th or later.
 *   • `subAgentTools` applies the caller's allowlist FIRST, then the cap; an
 *     agent the allowlist names exactly is never dropped, and whatever the cap
 *     does drop is logged by ref — never silent.
 */
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

const warn = vi.hoisted(() => vi.fn());
vi.mock("../logger.js", () => ({
  createChildLogger: () => ({ warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import { listCallableAgents } from "./definition.js";
import { MAX_OFFERED_SUBAGENTS, SubAgentBudget, subAgentTools } from "./subagents.js";
import { makeToolset } from "../ai/tool-runtime/toolset.js";
import type { AgentToolOwner, AgentToolsContext } from "./subagents.js";
import type { AIProvider } from "../ai/types.js";

const pad = (i: number): string => String(i).padStart(2, "0");

function customRow(i: number) {
  return {
    id: `c${pad(i)}`,
    projectId: "p1",
    name: `Agent ${pad(i)}`,
    description: "",
    systemPrompt: "",
    tools: "[]",
    model: null,
    reasoningEffort: null,
    skillKeys: "[]",
    approvalPolicy: null,
    version: "1.0.0",
  };
}

function fakeDb(customCount: number): PrismaClient {
  const custom = Array.from({ length: customCount }, (_, i) => customRow(i));
  return {
    customAgentEnablement: { findMany: async () => [] },
    customAgent: { findMany: async () => custom },
    projectAgentAllowlist: { findMany: async () => [] },
    agent: { findMany: async () => [] },
  } as unknown as PrismaClient;
}

async function ctxWith(count: number): Promise<AgentToolsContext> {
  return {
    provider: { key: "offline-stub" } as unknown as AIProvider,
    model: "m",
    session: { id: "s1", userId: "u1", projectId: "p1" },
    callable: await listCallableAgents("p1", { db: fakeDb(count) }),
    limits: { maxDepth: 2, tokenBudget: 1000, maxTurns: 6 },
    budget: new SubAgentBudget(1000),
  };
}

const owner = (allowlist: string[] | null): AgentToolOwner => ({
  depth: 0,
  runId: null,
  allowlist,
  baseToolset: makeToolset([]),
  policy: { low: "auto", medium: "auto", high: "auto" },
});

const offered = (ctx: AgentToolsContext, o: AgentToolOwner): string[] =>
  subAgentTools(ctx, o, new Set()).map((t) => t.name);

describe("listCallableAgents — no project-wide cap", () => {
  it("returns every callable agent, in order, with no warning", async () => {
    warn.mockClear();
    const list = await listCallableAgents("p1", { db: fakeDb(20) });
    expect(list).toHaveLength(20);
    expect(list[19]!.id).toBe("c19");
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("subAgentTools — the allowlist narrows first, then the cap", () => {
  it("an allowlist naming ONLY agents past the 16th offers exactly them", async () => {
    warn.mockClear();
    const ctx = await ctxWith(20);
    expect(offered(ctx, owner(["agent:custom:c17", "agent:custom:c19"]))).toEqual([
      "agent:custom:c17",
      "agent:custom:c19",
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("no allowlist: capped at MAX_OFFERED_SUBAGENTS, and the dropped refs are logged", async () => {
    warn.mockClear();
    const ctx = await ctxWith(MAX_OFFERED_SUBAGENTS + 2);
    expect(offered(ctx, owner(null))).toHaveLength(MAX_OFFERED_SUBAGENTS);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![1]).toMatchObject({
      projectId: "p1",
      callable: MAX_OFFERED_SUBAGENTS + 2,
      offered: MAX_OFFERED_SUBAGENTS,
      notOffered: [`custom:c${MAX_OFFERED_SUBAGENTS}`, `custom:c${MAX_OFFERED_SUBAGENTS + 1}`],
    });
  });

  it("at or under the cap: every admitted agent, no warning", async () => {
    warn.mockClear();
    const ctx = await ctxWith(3);
    expect(offered(ctx, owner(null))).toHaveLength(3);
    expect(warn).not.toHaveBeenCalled();
  });

  it("a wildcard fills the room left after the EXACTLY named agents — a named one is never dropped", async () => {
    warn.mockClear();
    const ctx = await ctxWith(30);
    const tools = offered(ctx, owner(["agent:*", "agent:custom:c29"]));
    expect(tools).toHaveLength(MAX_OFFERED_SUBAGENTS);
    expect(tools).toContain("agent:custom:c29");
    expect(tools.slice(0, MAX_OFFERED_SUBAGENTS - 1)).toEqual(
      Array.from({ length: MAX_OFFERED_SUBAGENTS - 1 }, (_, i) => `agent:custom:c${pad(i)}`),
    );
    expect(warn.mock.calls[0]![1].notOffered).not.toContain("custom:c29");
  });

  it("more exact names than the cap: all of them are offered", async () => {
    const ctx = await ctxWith(20);
    const all = Array.from({ length: 20 }, (_, i) => `agent:custom:c${pad(i)}`);
    expect(offered(ctx, owner(all))).toHaveLength(20);
  });
});
