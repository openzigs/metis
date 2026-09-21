/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Tests for the CustomAgent service (#112) — Prisma is mocked in-memory.
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

const rows = new Map<string, AgentRow>();
let nextId = 0;
function reset(): void {
  rows.clear();
  nextId = 0;
}

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    auditLog: { create: vi.fn(async () => ({})) },
    customAgent: {
      findMany: vi.fn(async ({ where }: { where: any }) => {
        const all = [...rows.values()];
        return all.filter((r) => {
          if (where.OR) {
            return where.OR.some((c: any) => {
              if (c.projectId === null && c.isBuiltIn === true)
                return r.projectId === null && r.isBuiltIn;
              return r.projectId === c.projectId;
            });
          }
          if (where.projectId === null && where.isBuiltIn === true)
            return r.projectId === null && r.isBuiltIn;
          return true;
        });
      }),
      findUnique: vi.fn(
        async ({
          where,
        }: {
          where: { id?: string; projectId_name?: { projectId: string | null; name: string } };
        }) => {
          if (where.id) return rows.get(where.id) ?? null;
          if (where.projectId_name) {
            for (const r of rows.values()) {
              if (
                r.projectId === where.projectId_name.projectId &&
                r.name === where.projectId_name.name
              )
                return r;
            }
            return null;
          }
          return null;
        },
      ),
      findFirst: vi.fn(async ({ where }: { where: { projectId: string | null; name: string } }) => {
        for (const r of rows.values()) {
          if (r.projectId === where.projectId && r.name === where.name) return r;
        }
        return null;
      }),
      create: vi.fn(
        async ({ data }: { data: Omit<AgentRow, "id" | "createdAt" | "updatedAt"> }) => {
          nextId++;
          const row: AgentRow = {
            id: `ag_${nextId}`,
            createdAt: new Date(),
            updatedAt: new Date(),
            ...data,
          };
          rows.set(row.id, row);
          return row;
        },
      ),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<AgentRow> }) => {
        const r = rows.get(where.id);
        if (!r) throw new Error("not found");
        Object.assign(r, data, { updatedAt: new Date() });
        return r;
      }),
      upsert: vi.fn(async (args: any) => {
        const existing = await (async () => {
          for (const r of rows.values()) {
            if (
              r.projectId === args.where.projectId_name.projectId &&
              r.name === args.where.projectId_name.name
            )
              return r;
          }
          return null;
        })();
        if (existing) {
          Object.assign(existing, args.update, { updatedAt: new Date() });
          return existing;
        }
        nextId++;
        const row: AgentRow = {
          id: `ag_${nextId}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...args.create,
        };
        rows.set(row.id, row);
        return row;
      }),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        rows.delete(where.id);
        return { id: where.id };
      }),
    },
  },
}));

import {
  BUILT_IN_AGENT_NAMES,
  CustomAgentError,
  createAgent,
  deleteAgent,
  ensureBuiltInAgents,
  getAgent,
  listAgents,
  updateAgent,
} from "../src/lib/custom-agents/index.js";

beforeEach(() => reset());
afterEach(() => reset());

describe("CustomAgent service (#112)", () => {
  it("seeds the four built-in specialists with isBuiltIn=true, projectId=null", async () => {
    await ensureBuiltInAgents();
    const list = await listAgents();
    expect(list).toHaveLength(BUILT_IN_AGENT_NAMES.length);
    for (const a of list) {
      expect(a.isBuiltIn).toBe(true);
      expect(a.projectId).toBeNull();
    }
    const names = list.map((a) => a.name).sort();
    expect(names).toEqual([...BUILT_IN_AGENT_NAMES].sort());
  });

  it("idempotent — repeat calls do not duplicate built-ins", async () => {
    await ensureBuiltInAgents();
    await ensureBuiltInAgents();
    const list = await listAgents();
    expect(list).toHaveLength(BUILT_IN_AGENT_NAMES.length);
  });

  it("creates a project-scoped custom agent", async () => {
    const created = await createAgent(
      {
        projectId: "p1",
        name: "MyAgent",
        description: "test",
        systemPrompt: "do",
        tools: ["a"],
      },
      "u1",
    );
    expect(created.projectId).toBe("p1");
    expect(created.isBuiltIn).toBe(false);
    expect(created.tools).toEqual(["a"]);
  });

  it("rejects duplicate names within a project", async () => {
    await createAgent(
      { projectId: "p1", name: "Dup", description: "", systemPrompt: "x", tools: [] },
      "u1",
    );
    await expect(
      createAgent(
        { projectId: "p1", name: "Dup", description: "", systemPrompt: "x", tools: [] },
        "u1",
      ),
    ).rejects.toThrow(CustomAgentError);
  });

  it("rejects invalid agent names", async () => {
    await expect(
      createAgent(
        { projectId: "p1", name: "1bad", description: "", systemPrompt: "x", tools: [] },
        "u1",
      ),
    ).rejects.toThrow(CustomAgentError);
  });

  it("rejects invalid tools / reasoningEffort", async () => {
    await expect(
      createAgent(
        {
          projectId: "p1",
          name: "T",
          description: "",
          systemPrompt: "x",
          tools: [123 as unknown as string],
        },
        "u1",
      ),
    ).rejects.toThrow(CustomAgentError);
    await expect(
      createAgent(
        {
          projectId: "p1",
          name: "T2",
          description: "",
          systemPrompt: "x",
          tools: [],
          reasoningEffort: "ultra" as never,
        },
        "u1",
      ),
    ).rejects.toThrow(CustomAgentError);
  });

  it("forbids deleting / updating built-ins", async () => {
    await ensureBuiltInAgents();
    const list = await listAgents();
    const builtin = list.find((a) => a.isBuiltIn)!;
    await expect(deleteAgent(builtin.id)).rejects.toThrow(CustomAgentError);
    await expect(updateAgent(builtin.id, { description: "x" })).rejects.toThrow(CustomAgentError);
  });

  it("updates a project-scoped agent", async () => {
    const created = await createAgent(
      { projectId: "p1", name: "Edit", description: "", systemPrompt: "x", tools: [] },
      "u1",
    );
    const updated = await updateAgent(created.id, { description: "new" }, "u1");
    expect(updated.description).toBe("new");
  });

  it("getAgent returns null for unknown ids", async () => {
    expect(await getAgent("nope")).toBeNull();
  });

  it("listAgents respects includeBuiltIns=false", async () => {
    await ensureBuiltInAgents();
    await createAgent(
      { projectId: "p1", name: "Custom", description: "", systemPrompt: "x", tools: [] },
      "u1",
    );
    const onlyCustom = await listAgents({ projectId: "p1", includeBuiltIns: false });
    expect(onlyCustom.every((a) => !a.isBuiltIn)).toBe(true);
    expect(onlyCustom.find((a) => a.name === "Custom")).toBeDefined();
  });
});
