/**
 * Epic #157 — Chronicle agentic memory unit tests.
 *
 * Uses an in-memory Prisma stub keyed on `(projectId, key)` so we can exercise
 * the upsert, lazy-purge, and `buildSystemBlock` paths without touching a
 * real database.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
  id: string;
  projectId: string;
  key: string;
  value: string;
  sourceSessionId: string | null;
  expiresAt: Date | null;
  createdAt: Date;
}

const projects = new Map<
  string,
  { chronicleEnabled: boolean; chronicleTtlDays: number | null; deletedAt: Date | null }
>();
const entries = new Map<string, Row>();
let nextId = 0;

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    project: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; deletedAt?: null } }) => {
        const p = projects.get(where.id);
        if (!p) return null;
        if ("deletedAt" in where && p.deletedAt) return null;
        return { id: where.id, ...p };
      }),
    },
    chronicleEntry: {
      findFirst: vi.fn(
        async ({ where }: { where: { id?: string; projectId?: string; key?: string } }) => {
          if (where.id) return entries.get(where.id) ?? null;
          for (const r of entries.values()) {
            if (r.projectId === where.projectId && r.key === where.key) return r;
          }
          return null;
        },
      ),
      findMany: vi.fn(
        async ({
          where,
          orderBy: _o,
          take,
        }: {
          where: { projectId: string };
          orderBy: unknown;
          take: number;
        }) => {
          const rows = [...entries.values()].filter((r) => r.projectId === where.projectId);
          rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
          return rows.slice(0, take);
        },
      ),
      create: vi.fn(async ({ data }: { data: Omit<Row, "id" | "createdAt"> }) => {
        nextId += 1;
        const row: Row = {
          id: `c_${nextId}`,
          createdAt: new Date(),
          sourceSessionId: data.sourceSessionId ?? null,
          expiresAt: data.expiresAt ?? null,
          projectId: data.projectId,
          key: data.key,
          value: data.value,
        };
        entries.set(row.id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const r = entries.get(where.id);
        if (!r) throw new Error("missing");
        const next = { ...r, ...data } as Row;
        entries.set(where.id, next);
        return next;
      }),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        const r = entries.get(where.id);
        if (!r) throw new Error("missing");
        entries.delete(where.id);
        return r;
      }),
      deleteMany: vi.fn(
        async ({
          where,
        }: {
          where: {
            projectId?: string;
            expiresAt: { lt: Date; not: Date | null };
          };
        }) => {
          let removed = 0;
          for (const [id, r] of entries) {
            if (where.projectId && r.projectId !== where.projectId) continue;
            if (!r.expiresAt || r.expiresAt.getTime() >= where.expiresAt.lt.getTime()) continue;
            entries.delete(id);
            removed += 1;
          }
          return { count: removed };
        },
      ),
    },
  },
}));

vi.mock("../src/lib/audit/audit-service.js", () => ({
  audit: vi.fn(),
}));

import {
  buildSystemBlock,
  forgetEntry,
  getEntries,
  isChronicleEnabled,
  purgeExpired,
  recordEntry,
} from "../src/lib/memory/chronicle.js";

beforeEach(() => {
  projects.clear();
  entries.clear();
  nextId = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("isChronicleEnabled", () => {
  it("returns true when the project flag is set", async () => {
    projects.set("p1", { chronicleEnabled: true, chronicleTtlDays: null, deletedAt: null });
    expect(await isChronicleEnabled("p1")).toBe(true);
  });

  it("returns false when disabled or unknown", async () => {
    projects.set("p1", { chronicleEnabled: false, chronicleTtlDays: null, deletedAt: null });
    expect(await isChronicleEnabled("p1")).toBe(false);
    expect(await isChronicleEnabled("missing")).toBe(false);
  });
});

describe("recordEntry", () => {
  it("returns null when chronicle is disabled", async () => {
    projects.set("p1", { chronicleEnabled: false, chronicleTtlDays: null, deletedAt: null });
    expect(await recordEntry("p1", "stack", "node 22")).toBeNull();
  });

  it("creates a fresh entry with TTL", async () => {
    projects.set("p1", { chronicleEnabled: true, chronicleTtlDays: 7, deletedAt: null });
    const entry = await recordEntry("p1", "stack", "node 22", { actorId: "u1" });
    expect(entry).not.toBeNull();
    expect(entry?.key).toBe("stack");
    expect(entry?.value).toBe("node 22");
    expect(entry?.expiresAt).not.toBeNull();
    expect(entries.size).toBe(1);
  });

  it("upserts on the same key", async () => {
    projects.set("p1", { chronicleEnabled: true, chronicleTtlDays: 7, deletedAt: null });
    await recordEntry("p1", "stack", "node 22");
    const second = await recordEntry("p1", "stack", "node 24");
    expect(entries.size).toBe(1);
    expect(second?.value).toBe("node 24");
  });
});

describe("getEntries / purgeExpired", () => {
  it("purges expired rows on read and returns the rest in DESC order", async () => {
    projects.set("p1", { chronicleEnabled: true, chronicleTtlDays: 1, deletedAt: null });
    await recordEntry("p1", "fresh", "x");
    // Manually plant an expired row.
    const stale: Row = {
      id: "stale",
      projectId: "p1",
      key: "stale",
      value: "y",
      sourceSessionId: null,
      expiresAt: new Date(Date.now() - 10_000),
      createdAt: new Date(Date.now() - 60_000),
    };
    entries.set("stale", stale);
    const list = await getEntries("p1");
    expect(list.map((r) => r.key)).toEqual(["fresh"]);
    expect(entries.has("stale")).toBe(false);
  });

  it("clamps the limit to 1..100", async () => {
    projects.set("p1", { chronicleEnabled: true, chronicleTtlDays: 7, deletedAt: null });
    await recordEntry("p1", "k", "v");
    const list = await getEntries("p1", { limit: 0 });
    expect(list).toHaveLength(1);
  });

  it("purgeExpired returns the deletion count", async () => {
    entries.set("e", {
      id: "e",
      projectId: "p1",
      key: "k",
      value: "v",
      sourceSessionId: null,
      expiresAt: new Date(Date.now() - 1000),
      createdAt: new Date(),
    });
    expect(await purgeExpired("p1")).toBe(1);
  });
});

describe("forgetEntry", () => {
  it("returns false on unknown id", async () => {
    expect(await forgetEntry("nope")).toBe(false);
  });

  it("deletes a known entry", async () => {
    projects.set("p1", { chronicleEnabled: true, chronicleTtlDays: 7, deletedAt: null });
    const entry = await recordEntry("p1", "k", "v");
    expect(entry).not.toBeNull();
    expect(await forgetEntry(entry!.id, { id: "actor1" })).toBe(true);
    expect(entries.size).toBe(0);
  });
});

describe("buildSystemBlock", () => {
  it("returns empty string when disabled", async () => {
    projects.set("p1", { chronicleEnabled: false, chronicleTtlDays: null, deletedAt: null });
    expect(await buildSystemBlock("p1")).toBe("");
  });

  it("returns markdown block with entries", async () => {
    projects.set("p1", { chronicleEnabled: true, chronicleTtlDays: 7, deletedAt: null });
    await recordEntry("p1", "stack", "node 22");
    await recordEntry("p1", "deploy", "us-east-1");
    const block = await buildSystemBlock("p1");
    expect(block).toContain("## Project memory (Chronicle)");
    expect(block).toContain("**stack**: node 22");
    expect(block).toContain("**deploy**: us-east-1");
  });

  it("returns empty when there are no entries", async () => {
    projects.set("p1", { chronicleEnabled: true, chronicleTtlDays: 7, deletedAt: null });
    expect(await buildSystemBlock("p1")).toBe("");
  });
});
