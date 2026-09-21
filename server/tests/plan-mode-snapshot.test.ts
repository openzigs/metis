/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Tests for plan-mode state machine (#121) and session snapshot persistence
 * (#122). Prisma is mocked in-memory.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface SessionRow {
  id: string;
  userId: string;
  projectId: string | null;
  title: string;
  model: string;
  currentModel: string | null;
  currentReasoningEffort: string | null;
  planModeActive: boolean;
  status: string;
  snapshot: string | null;
  snapshotUpdatedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface PlanRow {
  id: string;
  sessionId: string;
  planText: string;
  status: string;
  decidedAt: Date | null;
  decidedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const sessions = new Map<string, SessionRow>();
const plans = new Map<string, PlanRow>();
let seq = 0;

function reset(): void {
  sessions.clear();
  plans.clear();
  seq = 0;
}

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    auditLog: { create: vi.fn(async () => ({})) },
    aISession: {
      findUnique: vi.fn(async ({ where, select }: any) => {
        const row = sessions.get(where.id);
        if (!row) return null;
        if (select) {
          const out: any = {};
          for (const k of Object.keys(select)) out[k] = (row as any)[k];
          return out;
        }
        return row;
      }),
      findMany: vi.fn(async ({ where }: any) => {
        const all = [...sessions.values()].filter((r) => {
          if (where.userId && r.userId !== where.userId) return false;
          if (where.deletedAt === null && r.deletedAt !== null) return false;
          if (
            where.snapshotUpdatedAt?.gte &&
            (!r.snapshotUpdatedAt || r.snapshotUpdatedAt < where.snapshotUpdatedAt.gte)
          )
            return false;
          if (
            where.snapshotUpdatedAt?.lt &&
            (!r.snapshotUpdatedAt || r.snapshotUpdatedAt >= where.snapshotUpdatedAt.lt)
          )
            return false;
          if (where.snapshotUpdatedAt?.not === null && !r.snapshotUpdatedAt) return false;
          if (where.status?.in && !where.status.in.includes(r.status)) return false;
          return true;
        });
        return all;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const r = sessions.get(where.id);
        if (!r) throw new Error("not found");
        Object.assign(r, data, { updatedAt: new Date() });
        return r;
      }),
    },
    sessionPlan: {
      findFirst: vi.fn(async ({ where, orderBy }: any) => {
        const all = [...plans.values()].filter(
          (p) => p.sessionId === where.sessionId && (!where.status || p.status === where.status),
        );
        if (orderBy?.createdAt === "desc")
          all.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return all[0] ?? null;
      }),
      findUnique: vi.fn(async ({ where }: any) => plans.get(where.id) ?? null),
      create: vi.fn(async ({ data }: any) => {
        seq++;
        const row: PlanRow = {
          id: `plan_${seq}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          decidedAt: null,
          decidedBy: null,
          ...data,
        };
        plans.set(row.id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const r = plans.get(where.id);
        if (!r) throw new Error("not found");
        Object.assign(r, data, { updatedAt: new Date() });
        return r;
      }),
    },
  },
}));

import {
  PlanStateError,
  activatePlanMode,
  decidePlan,
  getCurrentPlan,
  recordPendingPlan,
} from "../src/lib/ai/plan-mode.js";
import {
  SessionSnapshotError,
  listResumable,
  readSnapshot,
  rehydrate,
  writeSnapshot,
} from "../src/lib/ai/session-snapshot.js";

function seedSession(id: string, overrides: Partial<SessionRow> = {}): SessionRow {
  const row: SessionRow = {
    id,
    userId: "u1",
    projectId: "p1",
    title: "T",
    model: "claude",
    currentModel: null,
    currentReasoningEffort: null,
    planModeActive: false,
    status: "active",
    snapshot: null,
    snapshotUpdatedAt: null,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
  sessions.set(id, row);
  return row;
}

beforeEach(reset);
afterEach(reset);

describe("plan-mode state machine (#121)", () => {
  it("creates a pending plan and activates plan-mode", async () => {
    seedSession("s1");
    const p = await recordPendingPlan("s1", "Step 1\nStep 2");
    expect(p.status).toBe("pending");
    expect(sessions.get("s1")!.planModeActive).toBe(true);
  });

  it("rejects empty plan text", async () => {
    seedSession("s1");
    await expect(recordPendingPlan("s1", "  ")).rejects.toThrow(PlanStateError);
  });

  it("rejects a second pending plan", async () => {
    seedSession("s1");
    await recordPendingPlan("s1", "p1");
    await expect(recordPendingPlan("s1", "p2")).rejects.toThrow(PlanStateError);
  });

  it("approve flips status and exits plan-mode", async () => {
    seedSession("s1");
    const p = await recordPendingPlan("s1", "p1");
    const decided = await decidePlan(p.id, "approved", "u1");
    expect(decided.status).toBe("approved");
    expect(decided.decidedBy).toBe("u1");
    expect(sessions.get("s1")!.planModeActive).toBe(false);
  });

  it("reject flips status and exits plan-mode", async () => {
    seedSession("s1");
    const p = await recordPendingPlan("s1", "p1");
    const decided = await decidePlan(p.id, "rejected");
    expect(decided.status).toBe("rejected");
    expect(sessions.get("s1")!.planModeActive).toBe(false);
  });

  it("cannot decide a plan that is no longer pending", async () => {
    seedSession("s1");
    const p = await recordPendingPlan("s1", "p1");
    await decidePlan(p.id, "approved");
    await expect(decidePlan(p.id, "rejected")).rejects.toThrow(PlanStateError);
  });

  it("getCurrentPlan returns the latest plan or null", async () => {
    seedSession("s1");
    expect(await getCurrentPlan("s1")).toBeNull();
    await recordPendingPlan("s1", "p");
    const got = await getCurrentPlan("s1");
    expect(got?.status).toBe("pending");
  });

  it("activatePlanMode toggles the flag without creating a plan", async () => {
    seedSession("s1");
    await activatePlanMode("s1");
    expect(sessions.get("s1")!.planModeActive).toBe(true);
  });

  it("decidePlan rejects unknown plan id", async () => {
    await expect(decidePlan("nope", "approved")).rejects.toThrow(PlanStateError);
  });
});

describe("session snapshot (#122)", () => {
  it("writes and reads a snapshot round-trip", async () => {
    seedSession("s1");
    await writeSnapshot("s1", {
      v: 1,
      messages: [{ role: "user", content: "hi" }],
      currentModel: "claude",
      currentReasoningEffort: "high",
      loadedSkillIds: ["x"],
      customAgentIds: ["a1"],
    });
    const snap = await readSnapshot("s1");
    expect(snap?.messages[0]?.content).toBe("hi");
    expect(snap?.currentModel).toBe("claude");
  });

  it("readSnapshot returns null when no snapshot exists", async () => {
    seedSession("s1");
    expect(await readSnapshot("s1")).toBeNull();
  });

  it("listResumable filters out sessions older than the TTL", async () => {
    const fresh = new Date();
    const old = new Date(Date.now() - 48 * 3600 * 1000);
    seedSession("fresh", { snapshotUpdatedAt: fresh, snapshot: '{"v":1}' });
    seedSession("old", { snapshotUpdatedAt: old, snapshot: '{"v":1}' });
    const list = await listResumable("u1");
    expect(list.map((s) => s.id)).toEqual(["fresh"]);
  });

  it("rehydrate returns the snapshot and dto for a fresh session", async () => {
    seedSession("s1", {
      snapshotUpdatedAt: new Date(),
      snapshot: JSON.stringify({
        v: 1,
        messages: [],
        currentModel: null,
        currentReasoningEffort: null,
        loadedSkillIds: [],
        customAgentIds: [],
      }),
    });
    const r = await rehydrate("s1");
    expect(r.session.id).toBe("s1");
    expect(r.snapshot?.v).toBe(1);
  });

  it("rehydrate refuses an expired session", async () => {
    seedSession("s1", { snapshotUpdatedAt: new Date(Date.now() - 48 * 3600 * 1000) });
    await expect(rehydrate("s1")).rejects.toThrow(SessionSnapshotError);
  });

  it("rehydrate refuses an unknown id", async () => {
    await expect(rehydrate("nope")).rejects.toThrow(SessionSnapshotError);
  });
});
