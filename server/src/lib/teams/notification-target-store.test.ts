/**
 * Issue #67 — TeamsNotificationTargetStore tests.
 *
 * Uses a fake Prisma modelling ONE `teams_notification_targets` table that
 * enforces the `(workspaceId, eventType)` unique key via UPSERT semantics.
 *
 * Proves: register creates then upserts in place (re-point a channel); blanks
 * are 400; getByEvent is workspace-scoped + returns the parsed reference + skips
 * inactive rows; list is workspace-scoped; delete is workspace-scoped (no
 * cross-workspace removal) and idempotent.
 */
import { describe, expect, it, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";

import {
  TeamsNotificationTargetStore,
  TeamsNotificationTargetError,
} from "./notification-target-store.js";

interface Row {
  id: string;
  workspaceId: string;
  eventType: string;
  conversationId: string;
  channelId: string;
  tenantId: string | null;
  reference: string;
  status: string;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

class FakeDb {
  rows: Row[] = [];
  seq = 0;

  teamsNotificationTarget = {
    upsert: async (args: {
      where: { workspaceId_eventType: { workspaceId: string; eventType: string } };
      create: Omit<Row, "id" | "createdAt" | "updatedAt">;
      update: Partial<Row>;
    }): Promise<Row> => {
      const { workspaceId, eventType } = args.where.workspaceId_eventType;
      const existing = this.rows.find(
        (r) => r.workspaceId === workspaceId && r.eventType === eventType,
      );
      if (existing) {
        Object.assign(existing, args.update, { updatedAt: new Date() });
        return existing;
      }
      const row: Row = {
        id: `nt_${++this.seq}`,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...(args.create as Omit<Row, "id" | "createdAt" | "updatedAt">),
      };
      this.rows.push(row);
      return row;
    },
    findUnique: async (args: {
      where: { workspaceId_eventType: { workspaceId: string; eventType: string } };
    }): Promise<Row | null> => {
      const { workspaceId, eventType } = args.where.workspaceId_eventType;
      return (
        this.rows.find((r) => r.workspaceId === workspaceId && r.eventType === eventType) ?? null
      );
    },
    findMany: async (args: { where: { workspaceId: string } }): Promise<Row[]> =>
      this.rows.filter((r) => r.workspaceId === args.where.workspaceId),
    deleteMany: async (args: {
      where: { workspaceId: string; eventType: string };
    }): Promise<{ count: number }> => {
      const before = this.rows.length;
      this.rows = this.rows.filter(
        (r) => !(r.workspaceId === args.where.workspaceId && r.eventType === args.where.eventType),
      );
      return { count: before - this.rows.length };
    },
  };
}

function makeStore(): { store: TeamsNotificationTargetStore; db: FakeDb } {
  const db = new FakeDb();
  return { store: new TeamsNotificationTargetStore(db as unknown as PrismaClient), db };
}

const base = {
  workspaceId: "ws-1",
  eventType: "analysis-complete",
  conversationId: "convo-1",
  channelId: "msteams",
  reference: { conversation: { id: "convo-1" }, serviceUrl: "https://svc" },
};

describe("TeamsNotificationTargetStore (#67)", () => {
  let store: TeamsNotificationTargetStore;
  let db: FakeDb;

  beforeEach(() => {
    ({ store, db } = makeStore());
  });

  it("registers a target and returns the summary", async () => {
    const t = await store.register({ ...base, tenantId: "tenant-a", createdById: "u-1" });
    expect(t.id).toBeTruthy();
    expect(t.workspaceId).toBe("ws-1");
    expect(t.eventType).toBe("analysis-complete");
    expect(t.conversationId).toBe("convo-1");
    expect(t.tenantId).toBe("tenant-a");
    expect(t.status).toBe("active");
  });

  it.each([
    ["workspaceId", { workspaceId: "" }],
    ["eventType", { eventType: " " }],
    ["conversationId", { conversationId: "" }],
    ["channelId", { channelId: "" }],
  ])("rejects a blank %s with a 400", async (_field, override) => {
    await expect(store.register({ ...base, ...override })).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(store.register({ ...base, ...override })).rejects.toBeInstanceOf(
      TeamsNotificationTargetError,
    );
  });

  it("re-registering the same (workspace, event) UPSERTS in place (re-points the channel)", async () => {
    const first = await store.register(base);
    const second = await store.register({
      ...base,
      conversationId: "convo-2",
      reference: { conversation: { id: "convo-2" } },
    });
    expect(second.id).toBe(first.id); // same row, not a duplicate
    expect(db.rows).toHaveLength(1);
    expect(second.conversationId).toBe("convo-2");
  });

  it("different events in the same workspace are separate targets", async () => {
    await store.register(base);
    await store.register({ ...base, eventType: "budget-exceeded", conversationId: "convo-b" });
    expect(await store.listByWorkspace("ws-1")).toHaveLength(2);
  });

  it("getByEvent returns the parsed reference, workspace-scoped", async () => {
    await store.register(base);
    const t = await store.getByEvent("ws-1", "analysis-complete");
    expect(t?.conversationId).toBe("convo-1");
    expect(t?.reference).toEqual({ conversation: { id: "convo-1" }, serviceUrl: "https://svc" });
    // Other workspace cannot read it.
    expect(await store.getByEvent("ws-2", "analysis-complete")).toBeNull();
    // Unregistered event → null.
    expect(await store.getByEvent("ws-1", "budget-exceeded")).toBeNull();
  });

  it("getByEvent treats an inactive target as not-registered (null)", async () => {
    await store.register(base);
    db.rows[0].status = "disabled";
    expect(await store.getByEvent("ws-1", "analysis-complete")).toBeNull();
  });

  it("lists only the workspace's targets", async () => {
    await store.register(base);
    await store.register({ ...base, workspaceId: "ws-2" });
    expect(await store.listByWorkspace("ws-1")).toHaveLength(1);
    expect(await store.listByWorkspace("ws-2")).toHaveLength(1);
  });

  it("deletes only the workspace's own target, idempotently", async () => {
    await store.register(base);
    // Wrong workspace cannot delete.
    expect(await store.delete("ws-other", "analysis-complete")).toBe(false);
    expect(await store.listByWorkspace("ws-1")).toHaveLength(1);
    // Correct workspace deletes; repeat is idempotent (false).
    expect(await store.delete("ws-1", "analysis-complete")).toBe(true);
    expect(await store.delete("ws-1", "analysis-complete")).toBe(false);
  });
});
