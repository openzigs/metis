/**
 * Epic #547 (Phase 1, #549) — TeamsChannelLinkStore tests.
 *
 * Uses a fake Prisma modelling ONE `teams_channel_links` table that enforces the
 * two uniqueness constraints (P2002 on collision):
 *   - `(workspaceId, conversationId)` — a channel maps to at most one thread.
 *   - `threadId` (global)             — a thread maps to at most one channel.
 *
 * Proves: create succeeds once; a second link on the SAME thread or the SAME
 * (workspace, conversation) is a 409 LINK_CONFLICT; lookups are workspace-scoped;
 * delete is workspace-scoped (cannot remove another workspace's link) and
 * idempotent.
 */
import { describe, expect, it, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";

import { TeamsChannelLinkStore, TeamsLinkError } from "./channel-link-store.js";

interface Row {
  id: string;
  workspaceId: string;
  threadId: string;
  projectId: string;
  conversationId: string;
  channelId: string;
  tenantId: string | null;
  status: string;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

class P2002 extends Error {
  code = "P2002";
}

class FakeDb {
  rows: Row[] = [];
  seq = 0;

  teamsChannelLink = {
    create: async (args: { data: Omit<Row, "id" | "createdAt" | "updatedAt"> }): Promise<Row> => {
      const d = args.data;
      // Enforce both unique keys exactly as Postgres/SQLite would.
      const convoClash = this.rows.some(
        (r) => r.workspaceId === d.workspaceId && r.conversationId === d.conversationId,
      );
      const threadClash = this.rows.some((r) => r.threadId === d.threadId);
      if (convoClash || threadClash) throw new P2002("Unique constraint failed");
      const row: Row = {
        id: `lnk_${++this.seq}`,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...d,
      };
      this.rows.push(row);
      return row;
    },
    findFirst: async (args: {
      where: { workspaceId: string; threadId?: string };
    }): Promise<Row | null> =>
      this.rows.find(
        (r) =>
          r.workspaceId === args.where.workspaceId &&
          (args.where.threadId === undefined || r.threadId === args.where.threadId),
      ) ?? null,
    findUnique: async (args: {
      where: { workspaceId_conversationId: { workspaceId: string; conversationId: string } };
    }): Promise<Row | null> => {
      const { workspaceId, conversationId } = args.where.workspaceId_conversationId;
      return (
        this.rows.find(
          (r) => r.workspaceId === workspaceId && r.conversationId === conversationId,
        ) ?? null
      );
    },
    findMany: async (args: { where: { workspaceId: string } }): Promise<Row[]> =>
      this.rows.filter((r) => r.workspaceId === args.where.workspaceId),
    deleteMany: async (args: {
      where: { id: string; workspaceId: string };
    }): Promise<{ count: number }> => {
      const before = this.rows.length;
      this.rows = this.rows.filter(
        (r) => !(r.id === args.where.id && r.workspaceId === args.where.workspaceId),
      );
      return { count: before - this.rows.length };
    },
  };
}

function makeStore(): { store: TeamsChannelLinkStore; db: FakeDb } {
  const db = new FakeDb();
  return { store: new TeamsChannelLinkStore(db as unknown as PrismaClient), db };
}

const base = {
  workspaceId: "ws-1",
  threadId: "th-1",
  projectId: "pr-1",
  conversationId: "convo-1",
  channelId: "msteams",
};

describe("TeamsChannelLinkStore (#549)", () => {
  let store: TeamsChannelLinkStore;

  beforeEach(() => {
    ({ store } = makeStore());
  });

  it("creates a link and returns the summary", async () => {
    const link = await store.create({ ...base, tenantId: "tenant-a", createdById: "u-1" });
    expect(link.id).toBeTruthy();
    expect(link.workspaceId).toBe("ws-1");
    expect(link.threadId).toBe("th-1");
    expect(link.conversationId).toBe("convo-1");
    expect(link.tenantId).toBe("tenant-a");
    expect(link.status).toBe("active");
  });

  it.each([
    ["workspaceId", { workspaceId: "" }],
    ["threadId", { threadId: " " }],
    ["projectId", { projectId: "" }],
    ["conversationId", { conversationId: "" }],
    ["channelId", { channelId: "" }],
  ])("rejects a blank %s with a 400", async (_field, override) => {
    await expect(store.create({ ...base, ...override })).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it("rejects a second link on the SAME thread (one channel per thread → 409)", async () => {
    await store.create(base);
    await expect(store.create({ ...base, conversationId: "convo-2" })).rejects.toBeInstanceOf(
      TeamsLinkError,
    );
    await expect(store.create({ ...base, conversationId: "convo-2" })).rejects.toMatchObject({
      statusCode: 409,
      code: "LINK_CONFLICT",
    });
  });

  it("rejects a second link on the SAME (workspace, conversation) (one thread per channel → 409)", async () => {
    await store.create(base);
    await expect(store.create({ ...base, threadId: "th-2" })).rejects.toMatchObject({
      statusCode: 409,
      code: "LINK_CONFLICT",
    });
  });

  it("looks a link up by thread (workspace-scoped)", async () => {
    await store.create(base);
    expect((await store.getByThread("ws-1", "th-1"))?.conversationId).toBe("convo-1");
    expect(await store.getByThread("ws-2", "th-1")).toBeNull();
    expect(await store.getByThread("ws-1", "th-nope")).toBeNull();
  });

  it("looks a link up by conversation (workspace-scoped)", async () => {
    await store.create(base);
    expect((await store.getByConversation("ws-1", "convo-1"))?.threadId).toBe("th-1");
    expect(await store.getByConversation("ws-2", "convo-1")).toBeNull();
  });

  it("lists only the workspace's links", async () => {
    await store.create(base);
    await store.create({ ...base, threadId: "th-2", conversationId: "convo-2" });
    const list = await store.listByWorkspace("ws-1");
    expect(list).toHaveLength(2);
    expect(await store.listByWorkspace("ws-2")).toHaveLength(0);
  });

  it("deletes only when the link belongs to the workspace (no cross-workspace unlink)", async () => {
    const link = await store.create(base);
    // Wrong workspace cannot delete even with the right id.
    expect(await store.delete("ws-other", link.id)).toBe(false);
    expect(await store.listByWorkspace("ws-1")).toHaveLength(1);
    // Correct workspace deletes; repeat delete is idempotent (false).
    expect(await store.delete("ws-1", link.id)).toBe(true);
    expect(await store.delete("ws-1", link.id)).toBe(false);
  });
});
