/**
 * Epic #129 (#147), review of PR #239 — `listCallableAgents` caps the agents
 * offered as tools; past the cap the rest are dropped, and that must be SAID
 * (a warning naming the project and the counts), never silent.
 */
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

const warn = vi.hoisted(() => vi.fn());
vi.mock("../logger.js", () => ({
  createChildLogger: () => ({ warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import { listCallableAgents } from "./definition.js";

function fakeDb(customCount: number): PrismaClient {
  const custom = Array.from({ length: customCount }, (_, i) => ({
    id: `c${i}`,
    projectId: "p1",
    name: `Agent ${String(i).padStart(2, "0")}`,
    description: "",
    systemPrompt: "",
    tools: "[]",
    model: null,
    reasoningEffort: null,
    skillKeys: "[]",
    approvalPolicy: null,
    version: "1.0.0",
  }));
  return {
    customAgentEnablement: { findMany: async () => [] },
    customAgent: { findMany: async () => custom },
    projectAgentAllowlist: { findMany: async () => [] },
    agent: { findMany: async () => [] },
  } as unknown as PrismaClient;
}

describe("listCallableAgents — the cap", () => {
  it("at or under the cap: every agent, no warning", async () => {
    warn.mockClear();
    expect(await listCallableAgents("p1", { db: fakeDb(3), limit: 3 })).toHaveLength(3);
    expect(warn).not.toHaveBeenCalled();
  });

  it("past the cap: the first `limit` are kept and the drop is logged with the counts", async () => {
    warn.mockClear();
    const list = await listCallableAgents("p1", { db: fakeDb(5), limit: 3 });
    expect(list.map((d) => d.id)).toEqual(["c0", "c1", "c2"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![1]).toMatchObject({ projectId: "p1", callable: 5, offered: 3 });
  });
});
