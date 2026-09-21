/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Epic #260 (#79) — CustomAgent <-> project enablement join.
 *
 * Round-trip: create agent, enable for a project, query enabled agents,
 * disable. Prisma is mocked in-memory.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface AgentRow {
  id: string;
  projectId: string | null;
  name: string;
  description: string;
  systemPrompt: string;
  tools: string;
  model: string | null;
  reasoningEffort: string | null;
  isBuiltIn: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface EnablementRow {
  id: string;
  customAgentId: string;
  projectId: string;
  enabled: boolean;
  enabledById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const agents = new Map<string, AgentRow>();
const enablements = new Map<string, EnablementRow>();
let nextId = 0;

function reset(): void {
  agents.clear();
  enablements.clear();
  nextId = 0;
}

function matchAgent(r: AgentRow, where: any): boolean {
  if (where.id?.in) return where.id.in.includes(r.id);
  if (typeof where.id === "string") return r.id === where.id;
  if (where.OR) {
    return where.OR.some((c: any) => {
      if (c.projectId === null && c.isBuiltIn === true) return r.projectId === null && r.isBuiltIn;
      if (c.id) {
        if (Array.isArray(c.id?.in)) return c.id.in.includes(r.id);
      }
      return r.projectId === c.projectId;
    });
  }
  if (where.id?.in) return where.id.in.includes(r.id);
  if (where.projectId === null && where.isBuiltIn === true)
    return r.projectId === null && r.isBuiltIn;
  if ("projectId" in where) return r.projectId === where.projectId;
  return true;
}

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    auditLog: { create: vi.fn(async () => ({})) },
    customAgent: {
      findUnique: vi.fn(async ({ where }: any) => agents.get(where.id) ?? null),
      findFirst: vi.fn(async ({ where }: any) => {
        for (const r of agents.values()) {
          if (r.projectId === where.projectId && r.name === where.name) return r;
        }
        return null;
      }),
      findMany: vi.fn(async ({ where }: any) =>
        [...agents.values()].filter((r) => matchAgent(r, where ?? {})),
      ),
      create: vi.fn(async ({ data }: any) => {
        nextId++;
        const row: AgentRow = {
          id: `ag_${nextId}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        agents.set(row.id, row);
        return row;
      }),
    },
    customAgentEnablement: {
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.id) return enablements.get(where.id) ?? null;
        if (where.customAgentId_projectId) {
          for (const e of enablements.values()) {
            if (
              e.customAgentId === where.customAgentId_projectId.customAgentId &&
              e.projectId === where.customAgentId_projectId.projectId
            )
              return e;
          }
        }
        return null;
      }),
      findMany: vi.fn(async ({ where }: any) =>
        [...enablements.values()].filter((e) => {
          if (where?.projectId && e.projectId !== where.projectId) return false;
          if (where && "enabled" in where && e.enabled !== where.enabled) return false;
          return true;
        }),
      ),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        for (const e of enablements.values()) {
          if (
            e.customAgentId === where.customAgentId_projectId.customAgentId &&
            e.projectId === where.customAgentId_projectId.projectId
          ) {
            Object.assign(e, update, { updatedAt: new Date() });
            return e;
          }
        }
        nextId++;
        const row: EnablementRow = {
          id: `en_${nextId}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...create,
        };
        enablements.set(row.id, row);
        return row;
      }),
    },
  },
}));

import {
  CustomAgentError,
  createAgent,
  isAgentEnabledForProject,
  listEnabledAgentsForProject,
  setAgentEnabledForProject,
} from "../src/lib/custom-agents/index.js";

beforeEach(() => reset());
afterEach(() => reset());

describe("CustomAgent enablement (#79)", () => {
  it("round-trip: create agent, enable for project, query, disable", async () => {
    const agent = await createAgent(
      { projectId: "owner-proj", name: "Sharable", description: "", systemPrompt: "x", tools: [] },
      "u1",
    );

    // initially not enabled for another project
    expect(await isAgentEnabledForProject(agent.id, "target-proj")).toBe(false);
    expect(await listEnabledAgentsForProject("target-proj")).toHaveLength(0);

    // enable
    const en = await setAgentEnabledForProject(agent.id, "target-proj", true, "u2");
    expect(en.enabled).toBe(true);
    expect(en.customAgentId).toBe(agent.id);
    expect(en.projectId).toBe("target-proj");

    // query enabled
    expect(await isAgentEnabledForProject(agent.id, "target-proj")).toBe(true);
    const enabled = await listEnabledAgentsForProject("target-proj");
    expect(enabled).toHaveLength(1);
    expect(enabled[0].id).toBe(agent.id);

    // idempotent enable does not duplicate
    await setAgentEnabledForProject(agent.id, "target-proj", true, "u2");
    expect(await listEnabledAgentsForProject("target-proj")).toHaveLength(1);

    // disable
    const dis = await setAgentEnabledForProject(agent.id, "target-proj", false, "u2");
    expect(dis.enabled).toBe(false);
    expect(await isAgentEnabledForProject(agent.id, "target-proj")).toBe(false);
    expect(await listEnabledAgentsForProject("target-proj")).toHaveLength(0);
  });

  it("rejects enabling a non-existent agent", async () => {
    await expect(setAgentEnabledForProject("nope", "p1", true, "u1")).rejects.toThrow(
      CustomAgentError,
    );
  });
});
