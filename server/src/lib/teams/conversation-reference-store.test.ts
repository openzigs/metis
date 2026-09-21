/**
 * Epic #547 (Phase 0, #548) — ConversationReference store tests.
 *
 * Uses a fake Prisma client modelling ONE shared `teams_conversation_references`
 * table with the `(workspaceId, conversationId)` unique key. Two separately
 * constructed `ConversationReferenceStore` instances share that one table — the
 * #541/#542 multi-replica pattern — proving a reference saved by one replica is
 * visible to another (the guarantee proactive delivery needs in later phases).
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { ConversationReference } from "botbuilder";

import { ConversationReferenceStore, conversationIdOf } from "./conversation-reference-store.js";

interface Row {
  id: string;
  installationId: string;
  workspaceId: string;
  conversationId: string;
  serviceUrl: string;
  tenantId: string | null;
  channelId: string;
  aadObjectId: string | null;
  userId: string | null;
  reference: string;
  createdAt: Date;
  updatedAt: Date;
}

/** A shared in-memory stand-in for the single Postgres table. */
class FakeSharedDb {
  rows: Row[] = [];
  seq = 0;
  private key(w: string, c: string) {
    return `${w}|${c}`;
  }
  teamsConversationReference = {
    upsert: async (args: {
      where: { workspaceId_conversationId: { workspaceId: string; conversationId: string } };
      create: Omit<Row, "id" | "createdAt" | "updatedAt">;
      update: Partial<Row>;
    }): Promise<Row> => {
      const { workspaceId, conversationId } = args.where.workspaceId_conversationId;
      const existing = this.rows.find(
        (r) => this.key(r.workspaceId, r.conversationId) === this.key(workspaceId, conversationId),
      );
      if (existing) {
        Object.assign(existing, args.update, { updatedAt: new Date() });
        return existing;
      }
      const row: Row = {
        id: `cr_${++this.seq}`,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...(args.create as Omit<Row, "id" | "createdAt" | "updatedAt">),
      };
      this.rows.push(row);
      return row;
    },
    findUnique: async (args: {
      where: { workspaceId_conversationId: { workspaceId: string; conversationId: string } };
    }): Promise<Row | null> => {
      const { workspaceId, conversationId } = args.where.workspaceId_conversationId;
      return (
        this.rows.find(
          (r) =>
            this.key(r.workspaceId, r.conversationId) === this.key(workspaceId, conversationId),
        ) ?? null
      );
    },
    findMany: async (args: { where: { workspaceId: string } }): Promise<Row[]> => {
      return this.rows.filter((r) => r.workspaceId === args.where.workspaceId);
    },
    deleteMany: async (args: {
      where: { workspaceId: string; conversationId: string };
    }): Promise<{ count: number }> => {
      const before = this.rows.length;
      this.rows = this.rows.filter(
        (r) =>
          !(
            r.workspaceId === args.where.workspaceId &&
            r.conversationId === args.where.conversationId
          ),
      );
      return { count: before - this.rows.length };
    },
  };
}

function makeRef(over: Partial<ConversationReference> = {}): Partial<ConversationReference> {
  return {
    serviceUrl: "https://smba.example.com/teams",
    channelId: "msteams",
    conversation: { id: "conv-1", tenantId: "tenant-xyz" } as ConversationReference["conversation"],
    user: { id: "29:abc", aadObjectId: "aad-123", name: "Ada" } as ConversationReference["user"],
    bot: { id: "28:bot", name: "METIS" } as ConversationReference["bot"],
    ...over,
  };
}

describe("ConversationReferenceStore (#548)", () => {
  let db: FakeSharedDb;
  let store: ConversationReferenceStore;

  beforeEach(() => {
    db = new FakeSharedDb();
    store = new ConversationReferenceStore(db as never);
  });

  it("save → get round-trips and extracts METIS routing metadata", async () => {
    const saved = await store.save("inst-1", "ws-1", makeRef());
    expect(saved.conversationId).toBe("conv-1");
    expect(saved.serviceUrl).toBe("https://smba.example.com/teams");
    expect(saved.tenantId).toBe("tenant-xyz");
    expect(saved.aadObjectId).toBe("aad-123");
    expect(saved.userId).toBe("29:abc");

    const got = await store.get("ws-1", "conv-1");
    expect(got).not.toBeNull();
    expect(got?.reference.conversation?.id).toBe("conv-1");
    expect(got?.reference.user?.id).toBe("29:abc");
  });

  it("save is idempotent — a re-save updates serviceUrl in place (no duplicate)", async () => {
    await store.save("inst-1", "ws-1", makeRef());
    await store.save(
      "inst-1",
      "ws-1",
      makeRef({ serviceUrl: "https://smba.example.com/teams/v2" }),
    );
    const all = await store.listByWorkspace("ws-1");
    expect(all).toHaveLength(1);
    expect(all[0].serviceUrl).toBe("https://smba.example.com/teams/v2");
  });

  it("delete removes the reference and is idempotent", async () => {
    await store.save("inst-1", "ws-1", makeRef());
    expect(await store.delete("ws-1", "conv-1")).toBe(true);
    expect(await store.get("ws-1", "conv-1")).toBeNull();
    // Deleting again is a no-op (returns false), never throws.
    expect(await store.delete("ws-1", "conv-1")).toBe(false);
  });

  it("is workspace-scoped — one workspace cannot read another's reference", async () => {
    await store.save("inst-1", "ws-1", makeRef());
    // Same conversation id, different workspace → distinct row, not visible.
    expect(await store.get("ws-2", "conv-1")).toBeNull();
    await store.save("inst-2", "ws-2", makeRef());
    expect(await store.listByWorkspace("ws-1")).toHaveLength(1);
    expect(await store.listByWorkspace("ws-2")).toHaveLength(1);
  });

  it("a reference saved by one replica is visible to another (shared store)", async () => {
    const replicaA = new ConversationReferenceStore(db as never);
    const replicaB = new ConversationReferenceStore(db as never);
    await replicaA.save("inst-1", "ws-1", makeRef());
    const seenByB = await replicaB.get("ws-1", "conv-1");
    expect(seenByB?.conversationId).toBe("conv-1");
  });

  it("refuses to persist a reference with no conversation id", async () => {
    await expect(store.save("inst-1", "ws-1", { serviceUrl: "x" })).rejects.toThrow(
      /conversation\.id/,
    );
  });

  it("conversationIdOf extracts the id and throws on a missing one", () => {
    expect(conversationIdOf(makeRef())).toBe("conv-1");
    expect(() => conversationIdOf({})).toThrow(/conversation\.id/);
  });

  it("handles a channel-scoped reference with no user (null aadObjectId/userId)", async () => {
    const saved = await store.save("inst-1", "ws-1", makeRef({ user: undefined }));
    expect(saved.aadObjectId).toBeNull();
    expect(saved.userId).toBeNull();
  });
});
