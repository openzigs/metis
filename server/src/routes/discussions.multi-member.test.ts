/**
 * #734 — a project's discussions are open to every member who can open the
 * project, and to nobody else, on every surface.
 *
 * One workspace (`ws1`) holds the project and two analysts, Alice and Bob.
 * Mallory is an authenticated user in another workspace (`ws2`). Nothing on
 * the access path is mocked: the REST routes, `canAccessThread` →
 * `assertProjectAccess`, the mention fan-out (`notify.ts`), the socket
 * `subscribe:thread` handler and the thread-room emitter all run for real.
 * Only the database (an in-memory model of those rows), the auth middleware
 * (who is calling) and the socket transport (a fake that delivers to the
 * sockets joined to a room) are doubles.
 *
 * Covered for both members and the non-member: list, read, post, mention,
 * edit/delete, the thread room join and the realtime emit.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { AuthPayload } from "@metis/shared";

// ── Who is calling ───────────────────────────────────────────────────────────
const USERS = {
  alice: { id: "alice", username: "alice", displayName: "Alice Analyst", ws: "ws1" },
  bob: { id: "bob", username: "bob", displayName: "Bob Reviewer", ws: "ws1" },
  mallory: { id: "mallory", username: "mallory", displayName: "Mallory Outsider", ws: "ws2" },
} as const;
type Who = keyof typeof USERS;

const authOf = (who: Who): AuthPayload => ({
  userId: USERS[who].id,
  username: USERS[who].username,
  role: "developer",
  permissions: [],
  workspaces: [USERS[who].ws],
});

let caller: AuthPayload = authOf("alice");
vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: () => void) => {
    (req as unknown as { user: AuthPayload }).user = caller;
    next();
  },
}));

// ── The database: an in-memory model of the rows the access path reads ──────
interface MessageRow {
  id: string;
  threadId: string;
  authorKind: string;
  authorUserId: string | null;
  aiProvider: string | null;
  aiModel: string | null;
  aiSessionId: string | null;
  body: string;
  origin: string;
  createdAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
}
const db = vi.hoisted(() => ({
  messages: [] as Array<Record<string, unknown>>,
  notifications: [] as Array<{ userId: string; type: string; href: string }>,
  seq: 0,
}));

const WORKSPACE_MEMBERS = Object.values(USERS).map((u) => ({ userId: u.id, workspaceId: u.ws }));
const PROJECT = { id: "p1", workspaceId: "ws1", deletedAt: null };
const THREAD = { id: "t1", projectId: "p1", deletedAt: null };

type Where = Record<string, unknown>;
const authorName = (row: Record<string, unknown>) => ({
  ...row,
  authorUser: {
    displayName: Object.values(USERS).find((u) => u.id === row.authorUserId)?.displayName ?? null,
  },
});

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    project: {
      findFirst: async ({ where }: { where: Where }) =>
        where.id === PROJECT.id && PROJECT.deletedAt === null ? { id: PROJECT.id } : null,
      findUnique: async ({
        where,
        select,
      }: {
        where: Where;
        select: { workspace?: { select: { members: { where: { userId: string } } } } };
      }) => {
        if (where.id !== PROJECT.id) return null;
        const userId = select.workspace?.select.members.where.userId;
        return {
          workspaceId: PROJECT.workspaceId,
          deletedAt: null,
          workspace: {
            deletedAt: null,
            members: WORKSPACE_MEMBERS.filter(
              (m) => m.workspaceId === PROJECT.workspaceId && m.userId === userId,
            ).map((m) => ({ id: `${m.workspaceId}:${m.userId}` })),
          },
        };
      },
    },
    workspaceMember: {
      findMany: async ({ where }: { where: { userId: string } }) =>
        WORKSPACE_MEMBERS.filter((m) => m.userId === where.userId).map((m) => ({
          workspaceId: m.workspaceId,
        })),
    },
    discussionThread: {
      findFirst: async ({ where }: { where: Where }) =>
        where.id === THREAD.id ? { id: THREAD.id, projectId: THREAD.projectId } : null,
      findMany: async ({ where }: { where: Where }) =>
        where.projectId === THREAD.projectId ? [{ ...THREAD, title: "Wave C" }] : [],
    },
    discussionMessage: {
      create: async ({ data, include }: { data: Record<string, unknown>; include?: unknown }) => {
        const row: MessageRow = {
          id: `m${++db.seq}`,
          aiProvider: null,
          aiModel: null,
          aiSessionId: null,
          origin: "metis",
          createdAt: new Date(),
          editedAt: null,
          deletedAt: null,
          ...(data as Partial<MessageRow>),
        } as MessageRow;
        db.messages.push(row as unknown as Record<string, unknown>);
        return include ? authorName({ ...row }) : { ...row };
      },
      findMany: async ({ where }: { where: Where }) =>
        db.messages
          .filter((m) => m.threadId === where.threadId && m.deletedAt === null)
          .map(authorName),
      findFirst: async ({ where }: { where: Where }) =>
        db.messages.find(
          (m) => m.id === where.id && m.threadId === where.threadId && m.deletedAt === null,
        ) ?? null,
      update: async ({
        where,
        data,
        include,
      }: {
        where: Where;
        data: Record<string, unknown>;
        include?: unknown;
      }) => {
        const row = db.messages.find((m) => m.id === where.id);
        if (!row) throw new Error("not found");
        Object.assign(row, data);
        return include ? authorName({ ...row }) : { ...row };
      },
    },
    user: {
      findMany: async ({ where }: { where: { OR: Array<{ username: { equals: string } }> } }) =>
        Object.values(USERS)
          .filter((u) => where.OR.some((o) => o.username.equals === u.username))
          .map((u) => ({ id: u.id, username: u.username })),
      findUnique: async ({ where }: { where: Where }) => {
        const u = Object.values(USERS).find((x) => x.id === where.id);
        return u ? { displayName: u.displayName, username: u.username } : null;
      },
    },
    userRole: { findFirst: async () => null },
    notificationPreference: { findMany: async () => [] },
    notification: {
      create: async ({ data }: { data: { userId: string; type: string; href: string } }) => {
        db.notifications.push(data);
        return data;
      },
    },
  },
}));

const audit = vi.fn();
vi.mock("../lib/audit/audit-service.js", () => ({ audit: (...a: unknown[]) => audit(...a) }));

// Outside the access path: no Teams bridge, no model.
vi.mock("../lib/teams/outbound-sync.js", () => ({ scheduleMirrorToTeams: vi.fn() }));
vi.mock("./ai.js", () => ({ buildAutoRagContext: vi.fn() }));
vi.mock("../lib/discussions/grounding.js", () => ({ resolveDiscussionTools: vi.fn() }));
vi.mock("../lib/discussions/ai-responder.js", () => ({ streamAIReply: vi.fn() }));
vi.mock("../lib/ai/index.js", () => ({ buildProvider: vi.fn(), loadAIConfig: vi.fn() }));

// ── The socket transport: delivers to the sockets joined to a room ───────────
const transport = vi.hoisted(() => ({
  rooms: new Map<string, Set<string>>(),
  inbox: new Map<string, Array<{ event: string; payload: unknown }>>(),
}));
vi.mock("../lib/socket/registry.js", () => ({
  getSocketServer: () => ({
    to: (room: string) => ({
      emit: (event: string, payload: unknown) => {
        for (const socketId of transport.rooms.get(room) ?? []) {
          transport.inbox.get(socketId)?.push({ event, payload });
        }
      },
    }),
  }),
}));

const { userRoom, threadRoom } = await import("@metis/shared");
const { discussionsRouter } = await import("./discussions.js");
const { errorHandler } = await import("../middleware/error-handler.js");
const { wireThreadRoomHandlers } = await import("../lib/socket/discussion-rooms.js");
const { __resetMentionNotifyLimiter } = await import("../lib/discussions/notify.js");
type ThreadRoomSocket = import("../lib/socket/discussion-rooms.js").ThreadRoomSocket;

/**
 * A connected socket for `who`: auto-joined to its personal room, as the
 * server does from the verified JWT, with `subscribe:thread` wired for real.
 */
function connect(who: Who) {
  const id = `sock-${who}`;
  const handlers = new Map<string, (payload: unknown) => void>();
  const join = (room: string) => {
    if (!transport.rooms.has(room)) transport.rooms.set(room, new Set());
    transport.rooms.get(room)!.add(id);
  };
  transport.inbox.set(id, []);
  join(userRoom(USERS[who].id));
  const socket = {
    id,
    data: { user: authOf(who) },
    on: (event: string, h: (payload: unknown) => void) => {
      handlers.set(event, h);
      return socket;
    },
    join: async (room: string) => join(room),
    leave: async () => undefined,
    emit: (event: string, payload: unknown) =>
      transport.inbox.get(id)!.push({ event: `local:${event}`, payload }),
  };
  wireThreadRoomHandlers(socket as unknown as ThreadRoomSocket);
  return {
    async subscribe(threadId: string) {
      handlers.get("subscribe:thread")?.({ threadId });
      await vi.waitFor(() =>
        expect(
          transport.rooms.get(threadRoom(threadId))?.has(id) ||
            transport.inbox.get(id)!.some((e) => e.event === "local:auth:error"),
        ).toBe(true),
      );
    },
    inThread: (threadId: string) => transport.rooms.get(threadRoom(threadId))?.has(id) ?? false,
    received: (event: string) =>
      transport.inbox
        .get(id)!
        .filter((e) => e.event === event)
        .map((e) => e.payload),
  };
}

function app() {
  const a = express();
  a.use(express.json());
  a.use("/discussions", discussionsRouter());
  a.use(errorHandler);
  return a;
}

function as(who: Who) {
  caller = authOf(who);
  return request(app());
}

/** Let the fire-and-forget mention fan-out settle. */
const settle = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
  db.messages.length = 0;
  db.notifications.length = 0;
  transport.rooms.clear();
  transport.inbox.clear();
  audit.mockClear();
  __resetMentionNotifyLimiter();
});

describe("#734 — two workspace members and one non-member", () => {
  it("list: both members see the project's threads; the non-member gets the project's 404", async () => {
    for (const who of ["alice", "bob"] as const) {
      const res = await as(who).get("/discussions/threads?projectId=p1");
      expect(res.status).toBe(200);
      expect(res.body.data.map((t: { id: string }) => t.id)).toEqual(["t1"]);
    }
    const denied = await as("mallory").get("/discussions/threads?projectId=p1");
    expect(denied.status).toBe(404);
    expect(denied.body.error.code).toBe("NOT_FOUND");
    expect(JSON.stringify(denied.body)).not.toContain("t1");
  });

  it("read + post: a member reads and posts; the non-member gets the same 404 as an unknown thread", async () => {
    const posted = await as("alice").post("/discussions/threads/t1/messages").send({ body: "hi" });
    expect(posted.status).toBe(201);
    expect(posted.body.data.authorName).toBe("Alice Analyst");

    const reply = await as("bob").post("/discussions/threads/t1/messages").send({ body: "hello" });
    expect(reply.status).toBe(201);

    const read = await as("bob").get("/discussions/threads/t1/messages");
    expect(read.status).toBe(200);
    expect(read.body.data.map((m: { authorName: string }) => m.authorName)).toEqual([
      "Alice Analyst",
      "Bob Reviewer",
    ]);

    const unknown = await as("mallory").get("/discussions/threads/nope/messages");
    const forbiddenRead = await as("mallory").get("/discussions/threads/t1/messages");
    const forbiddenPost = await as("mallory")
      .post("/discussions/threads/t1/messages")
      .send({ body: "let me in" });
    for (const res of [forbiddenRead, forbiddenPost]) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual(unknown.body);
    }
    expect(db.messages.map((m) => m.authorUserId)).toEqual(["alice", "bob"]);
  });

  it("socket: a member joins the thread room and receives the live message; the non-member is refused and receives nothing", async () => {
    const bob = connect("bob");
    const mallory = connect("mallory");
    await bob.subscribe("t1");
    await mallory.subscribe("t1");

    expect(bob.inThread("t1")).toBe(true);
    expect(mallory.inThread("t1")).toBe(false);
    expect(mallory.received("local:auth:error")).toHaveLength(1);

    await as("alice").post("/discussions/threads/t1/messages").send({ body: "live update" });

    const live = bob.received("message:new") as Array<{
      message: { body: string; authorName?: string };
    }>;
    expect(live).toHaveLength(1);
    expect(live[0].message.body).toBe("live update");
    // A teammate's live message names them, not their raw user id.
    expect(live[0].message.authorName).toBe("Alice Analyst");
    expect(mallory.received("message:new")).toEqual([]);
  });

  it("mention: a member is notified; a non-member and an unknown name are dropped, and the author cannot tell them apart", async () => {
    const bob = connect("bob");
    const mallory = connect("mallory");

    const toOutsider = await as("alice")
      .post("/discussions/threads/t1/messages")
      .send({ body: "@mallory please look" });
    const toNobody = await as("alice")
      .post("/discussions/threads/t1/messages")
      .send({ body: "@ghost please look" });
    const toMember = await as("alice")
      .post("/discussions/threads/t1/messages")
      .send({ body: "@bob please look" });
    await settle();

    // Bob: one persisted notification linking to the thread, one socket event.
    expect(db.notifications).toEqual([
      expect.objectContaining({
        userId: "bob",
        type: "discussion_mention",
        href: "/projects/p1/discussions/t1",
      }),
    ]);
    expect(bob.received("discussion:mention")).toEqual([
      expect.objectContaining({
        kind: "discussion_mention",
        threadId: "t1",
        mentionedUserId: "bob",
      }),
    ]);

    // Mallory: nothing persisted, nothing emitted to her personal room.
    expect(db.notifications.some((n) => n.userId === "mallory")).toBe(false);
    expect(mallory.received("discussion:mention")).toEqual([]);

    // The author's responses carry no trace of who was (or was not) notified.
    for (const res of [toOutsider, toNobody, toMember]) expect(res.status).toBe(201);
    const shape = (b: { data: Record<string, unknown> }) => Object.keys(b.data).sort();
    expect(shape(toOutsider.body)).toEqual(shape(toNobody.body));
    expect(shape(toMember.body)).toEqual(shape(toNobody.body));
  });

  it("edit/delete: only the author changes a message; another member gets 403, the non-member the thread's 404", async () => {
    const bob = connect("bob");
    const mallory = connect("mallory");
    await bob.subscribe("t1");
    await mallory.subscribe("t1");

    const posted = await as("alice").post("/discussions/threads/t1/messages").send({ body: "v1" });
    const path = `/discussions/threads/t1/messages/${posted.body.data.id}`;

    const outsider = await as("mallory").patch(path).send({ body: "pwned" });
    expect(outsider.status).toBe(404);
    expect(outsider.body.error.code).toBe("THREAD_NOT_FOUND");
    expect((await as("mallory").delete(path)).status).toBe(404);

    const teammate = await as("bob").patch(path).send({ body: "not mine" });
    expect(teammate.status).toBe(403);
    expect((await as("bob").delete(path)).status).toBe(403);

    // The author's edit adds a mention of Bob: notified once, live to members only.
    const edited = await as("alice").patch(path).send({ body: "v2 @bob @mallory" });
    expect(edited.status).toBe(200);
    expect(edited.body.data.body).toBe("v2 @bob @mallory");
    await settle();
    expect(db.notifications.map((n) => n.userId)).toEqual(["bob"]);
    expect(bob.received("message:updated")).toHaveLength(1);
    expect(mallory.received("message:updated")).toEqual([]);

    const deleted = await as("alice").delete(path);
    expect(deleted.status).toBe(200);
    expect(bob.received("message:deleted")).toEqual([
      expect.objectContaining({ threadId: "t1", messageId: posted.body.data.id }),
    ]);
    expect(mallory.received("message:deleted")).toEqual([]);

    const after = await as("bob").get("/discussions/threads/t1/messages");
    expect(after.body.data).toEqual([]);
  });
});
