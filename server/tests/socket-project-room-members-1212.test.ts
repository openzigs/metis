/**
 * #1212 — the `project:{id}` socket room admits every user who can open the
 * project (`assertProjectAccess`), not only its creator, and lets go of anyone
 * who loses that right.
 *
 * One workspace (`ws1`) holds project `p1` and two analysts: Alice, who
 * created the project, and Bob, who did not. Mallory is an authenticated user
 * in another workspace (`ws2`). `p-legacy` predates workspaces.
 *
 * Nothing on the access path is mocked: the real `subscribe:project` handler
 * (`wireProjectRoomHandlers`) → `canJoinProjectRoom` →
 * `canAccessProjectDiscussions` → `assertProjectAccess`, the real job-event
 * emitter, the real eviction module and the real re-validation pass all run.
 * The database is an in-memory model whose `project.findMany` honours
 * `createdById`, so the scheduler's creator-only rule — were it restored —
 * would admit Alice alone and these tests would fail on Bob.
 *
 * The transport is an in-process fake (rooms are sets, an emit lands in each
 * member's inbox synchronously) and every step awaits the handler's own
 * promise, so there is no TCP handshake to starve and no sleep to tune (#1379).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { userRoom, type AuthPayload } from "@metis/shared";

type Where = Record<string, unknown>;

const db = vi.hoisted(() => ({
  /** Live workspace memberships. */
  members: [] as Array<{ userId: string; workspaceId: string }>,
  projects: [] as Array<{
    id: string;
    workspaceId: string | null;
    createdById: string;
    deletedAt: Date | null;
  }>,
  deletedWorkspaces: new Set<string>(),
  roles: new Map<string, string>(),
  /** When set, `assertProjectAccess`'s read for this user waits on it. */
  gate: null as null | { userId: string; opened: Promise<void>; reached: () => void },
  /** Live-project reads that fail before they succeed again (a database blip). */
  failures: 0,
  /** When true, listing a workspace's projects fails. */
  listDown: false,
}));

const audit = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/audit/audit-service.js", () => ({
  audit: (...args: unknown[]) => audit(...args),
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    // The live-user read of the re-validation pass: everyone is an active user.
    user: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        username: where.id,
        authRoleAuthority: null,
      })),
    },
    userRole: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async ({ where }: { where: { userId: string } }) => [
        { source: "local", role: { key: db.roles.get(where.userId) ?? "developer" } },
      ]),
    },
    // `readLiveWorkspaceIds` — the memberships of live workspaces.
    workspaceMember: {
      findMany: vi.fn(async ({ where }: { where: { userId: string } }) =>
        db.members
          .filter((m) => m.userId === where.userId && !db.deletedWorkspaces.has(m.workspaceId))
          .map((m) => ({ workspaceId: m.workspaceId })),
      ),
    },
    project: {
      // `canAccessProjectDiscussions`: a live project.
      findFirst: vi.fn(async ({ where }: { where: Where }) => {
        if (db.failures > 0) {
          db.failures -= 1;
          throw new Error("db down");
        }
        const p = db.projects.find((x) => x.id === where.id);
        if (!p) return null;
        if (where.deletedAt === null && p.deletedAt !== null) return null;
        return { id: p.id };
      }),
      // `assertProjectAccess`: the project's workspace and the caller's membership row.
      findUnique: vi.fn(
        async ({
          where,
          select,
        }: {
          where: Where;
          select?: { workspace?: { select?: { members?: { where?: { userId?: string } } } } };
        }) => {
          const userId = select?.workspace?.select?.members?.where?.userId;
          const p = db.projects.find((x) => x.id === where.id);
          if (!p) return null;
          const row = {
            workspaceId: p.workspaceId,
            workspace: p.workspaceId
              ? {
                  deletedAt: db.deletedWorkspaces.has(p.workspaceId) ? new Date() : null,
                  members: db.members
                    .filter((m) => m.workspaceId === p.workspaceId && m.userId === userId)
                    .map((m) => ({ id: `${m.workspaceId}:${m.userId}` })),
                }
              : null,
          };
          // The read's snapshot is taken above; a gated read answers from it
          // after whatever commits while it waits.
          const gate = db.gate;
          if (gate && gate.userId === userId) {
            db.gate = null;
            gate.reached();
            await gate.opened;
          }
          return row;
        },
      ),
      // The scheduler's creator-only rule filters on `createdById`; the
      // eviction module lists a workspace's projects by `workspaceId`.
      findMany: vi.fn(async ({ where }: { where: Where }) => {
        if (db.listDown && "workspaceId" in where) throw new Error("db down");
        return db.projects
          .filter((p) =>
            Object.entries(where).every(([k, v]) =>
              k === "deletedAt" ? v !== null || p.deletedAt === null : p[k as keyof typeof p] === v,
            ),
          )
          .map((p) => ({ id: p.id }));
      }),
    },
  },
}));

import { createJobEventEmitter, _resetJobLifecycleMemory } from "../src/lib/socket/job-events.js";
import {
  evictMemberProjectRooms,
  evictProjectRoom,
  evictWorkspaceProjectRooms,
} from "../src/lib/socket/project-room-eviction.js";
import {
  PROJECT_ROOM_DENIAL,
  wireProjectRoomHandlers,
  type ProjectRoomSocket,
} from "../src/lib/socket/project-rooms.js";
import { registerSocketServer } from "../src/lib/socket/registry.js";
import { revalidateLocalSockets, type MetisIOServer } from "../src/lib/socket/server.js";

// ── The in-process transport ────────────────────────────────────────────────
interface FakeSocket {
  id: string;
  data: { user: AuthPayload };
  rooms: Set<string>;
  inbox: Array<{ event: string; payload: unknown }>;
  handlers: Map<string, (payload: unknown) => unknown>;
}
const sockets = new Map<string, FakeSocket>();
const inRoom = (room: string) => [...sockets.values()].filter((s) => s.rooms.has(room));
const leaveAll = (members: FakeSocket[], rooms: string | string[]) => {
  for (const s of members) for (const r of [rooms].flat()) s.rooms.delete(r);
};
const broadcast = {
  in: (room: string) => ({
    socketsLeave: (rooms: string | string[]) => leaveAll(inRoom(room), rooms),
  }),
  socketsLeave: (rooms: string | string[]) => leaveAll([...sockets.values()], rooms),
};
const io = {
  ...broadcast,
  local: broadcast,
  of: () => ({ sockets }),
  to: (room: string) => ({
    emit: (event: string, payload: unknown) => {
      for (const s of inRoom(room)) s.inbox.push({ event, payload });
    },
  }),
} as unknown as MetisIOServer;
registerSocketServer(io);

let seq = 0;
/** A connected socket for `userId`, with the real project-room handlers wired. */
function connect(userId: string, claim: Partial<AuthPayload> = {}) {
  const id = `sock-${userId}-${++seq}`;
  const s: FakeSocket = {
    id,
    data: {
      user: {
        userId,
        username: userId,
        role: (db.roles.get(userId) ?? "developer") as AuthPayload["role"],
        permissions: [],
        ...claim,
      },
    },
    rooms: new Set([id, userRoom(userId)]),
    inbox: [],
    handlers: new Map(),
  };
  const socket = {
    id,
    data: s.data,
    rooms: s.rooms,
    nsp: { server: io },
    conn: { close: vi.fn() },
    disconnect: vi.fn(),
    on: (event: string, h: (payload: unknown) => unknown) => {
      s.handlers.set(event, h);
      return socket;
    },
    emit: (event: string, payload: unknown) => {
      s.inbox.push({ event: `local:${event}`, payload });
      return true;
    },
    join: async (room: string) => void s.rooms.add(room),
    leave: async (room: string) => void s.rooms.delete(room),
  };
  sockets.set(id, Object.assign(s, socket));
  wireProjectRoomHandlers(socket as unknown as ProjectRoomSocket);
  return {
    /** Run `subscribe:project` to completion. */
    subscribe: async (projectId: string) =>
      await s.handlers.get("subscribe:project")!({ projectId }),
    /** Start `subscribe:project` without waiting for it. */
    subscribeLater: (projectId: string) => s.handlers.get("subscribe:project")!({ projectId }),
    inRoom: (projectId: string) => s.rooms.has(`project:${projectId}`),
    /** Times the server closed this socket's transport (the client then reconnects). */
    closed: () => socket.conn.close.mock.calls.length,
    jobs: () => s.inbox.filter((e) => e.event === "job:lifecycle").map((e) => e.payload),
    refusals: () => s.inbox.filter((e) => e.event === "local:auth:error").map((e) => e.payload),
  };
}

const emitProgress = (projectId = "p1") =>
  createJobEventEmitter(io).progress("analysis", "job-1", projectId, 40, "Analysing");
const DENIED = [{ message: PROJECT_ROOM_DENIAL }];

beforeEach(() => {
  sockets.clear();
  db.members = [
    { userId: "alice", workspaceId: "ws1" },
    { userId: "bob", workspaceId: "ws1" },
    { userId: "mallory", workspaceId: "ws2" },
  ];
  db.projects = [
    { id: "p1", workspaceId: "ws1", createdById: "alice", deletedAt: null },
    { id: "p-mallory", workspaceId: "ws2", createdById: "mallory", deletedAt: null },
    { id: "p-gone", workspaceId: "ws1", createdById: "bob", deletedAt: new Date() },
    { id: "p-legacy", workspaceId: null, createdById: "alice", deletedAt: null },
  ];
  db.deletedWorkspaces.clear();
  db.roles.clear();
  db.gate = null;
  db.failures = 0;
  db.listDown = false;
  audit.mockClear();
  _resetJobLifecycleMemory();
});

describe("#1212 — subscribe:project admits every project member", () => {
  it("both workspace members receive a job-progress event — including Bob, who did not create the project", async () => {
    const alice = connect("alice");
    const bob = connect("bob");
    await alice.subscribe("p1");
    await bob.subscribe("p1");

    expect(bob.refusals()).toEqual([]);
    emitProgress();
    for (const member of [alice, bob]) {
      expect(member.jobs()).toEqual([
        expect.objectContaining({
          jobId: "job-1",
          projectId: "p1",
          status: "progress",
          progress: 40,
        }),
      ]);
    }
  });

  it("refuses a non-member, who then receives nothing broadcast to the room", async () => {
    const alice = connect("alice");
    const mallory = connect("mallory");
    await alice.subscribe("p1");
    await mallory.subscribe("p1");

    expect(mallory.refusals()).toEqual(DENIED);
    emitProgress();
    expect(mallory.jobs()).toEqual([]);
    expect(alice.jobs()).toHaveLength(1);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { id: "mallory" },
        action: "socket.subscribe:project.denied",
        target: { type: "project_room", id: "p1" },
      }),
    );
  });

  it("refuses a project that exists exactly as one that does not, so a join is no existence oracle", async () => {
    const mallory = connect("mallory");
    await mallory.subscribe("p1");
    await mallory.subscribe("p-does-not-exist");
    expect(mallory.refusals()).toEqual([...DENIED, ...DENIED]);
  });

  it("refuses a member a soft-deleted project of their own workspace", async () => {
    const bob = connect("bob");
    await bob.subscribe("p-gone");
    expect(bob.refusals()).toEqual(DENIED);
    expect(bob.inRoom("p-gone")).toBe(false);
  });

  it("admits an admin to a project in a workspace they do not belong to", async () => {
    db.roles.set("root", "admin");
    const root = connect("root");
    await root.subscribe("p1");
    expect(root.refusals()).toEqual([]);
    expect(root.inRoom("p1")).toBe(true);
  });

  it("admits a non-member to a legacy project with no workspace, as GET /projects/:id does", async () => {
    const mallory = connect("mallory");
    await mallory.subscribe("p-legacy");
    expect(mallory.refusals()).toEqual([]);
    emitProgress("p-legacy");
    expect(mallory.jobs()).toHaveLength(1);
  });

  it("refuses a stale token claim: membership is read from the database, not the token", async () => {
    // Eve's token still names ws1; the database has no membership row for her.
    const eve = connect("eve", { workspaces: ["ws1"] });
    await eve.subscribe("p1");
    expect(eve.refusals()).toEqual(DENIED);
    expect(eve.inRoom("p1")).toBe(false);
  });

  it("refuses the project's creator once they have left its workspace", async () => {
    db.members = db.members.filter((m) => m.userId !== "alice");
    const alice = connect("alice");
    await alice.subscribe("p1");
    expect(alice.refusals()).toEqual(DENIED);
  });
});

describe("#1212 — a transient database error does not cost a member the room", () => {
  it("retries a failed check once, so one blip does not refuse a new join", async () => {
    const bob = connect("bob");
    db.failures = 1;
    await bob.subscribe("p1");
    expect(bob.refusals()).toEqual([]);
    expect(bob.inRoom("p1")).toBe(true);
  });

  it("keeps a member already in the room when the check fails twice, and refuses a new join", async () => {
    const alice = connect("alice");
    const bob = connect("bob");
    await alice.subscribe("p1");
    db.failures = 2;
    await alice.subscribe("p1");
    expect(alice.inRoom("p1")).toBe(true);
    expect(alice.refusals()).toEqual([]);

    db.failures = 2;
    await bob.subscribe("p1");
    expect(bob.inRoom("p1")).toBe(false);
    expect(bob.refusals()).toEqual(DENIED);
  });
});

describe("#1212 — a member who loses access stops receiving the room's events", () => {
  it("evicts a removed member's sockets; the remaining member keeps receiving", async () => {
    const alice = connect("alice");
    const bob = connect("bob");
    await alice.subscribe("p1");
    await bob.subscribe("p1");

    db.members = db.members.filter((m) => m.userId !== "bob");
    await evictMemberProjectRooms("bob", "ws1");

    emitProgress();
    expect(bob.jobs()).toEqual([]);
    expect(alice.jobs()).toHaveLength(1);
    await bob.subscribe("p1");
    expect(bob.refusals()).toEqual(DENIED);
  });

  it("keeps the removed member in rooms of other workspaces' projects", async () => {
    db.members.push({ userId: "bob", workspaceId: "ws2" });
    const bob = connect("bob");
    await bob.subscribe("p1");
    await bob.subscribe("p-mallory");

    db.members = db.members.filter((m) => !(m.userId === "bob" && m.workspaceId === "ws1"));
    await evictMemberProjectRooms("bob", "ws1");
    expect(bob.inRoom("p1")).toBe(false);
    expect(bob.inRoom("p-mallory")).toBe(true);
  });

  it("re-admits a member removed and then added back", async () => {
    const bob = connect("bob");
    await bob.subscribe("p1");
    db.members = db.members.filter((m) => m.userId !== "bob");
    await evictMemberProjectRooms("bob", "ws1");
    expect(bob.inRoom("p1")).toBe(false);

    db.members.push({ userId: "bob", workspaceId: "ws1" });
    await bob.subscribe("p1");
    emitProgress();
    expect(bob.jobs()).toHaveLength(1);
  });

  it("takes every member out of a deleted workspace's project rooms; an admin stays", async () => {
    db.roles.set("root", "admin");
    const alice = connect("alice");
    const bob = connect("bob");
    const root = connect("root");
    await alice.subscribe("p1");
    await bob.subscribe("p1");
    await root.subscribe("p1");

    db.deletedWorkspaces.add("ws1");
    await evictWorkspaceProjectRooms("ws1");
    emitProgress();
    expect(alice.jobs()).toEqual([]);
    expect(bob.jobs()).toEqual([]);
    expect(root.jobs()).toHaveLength(1);
  });

  it("re-judges every project room when a deleted workspace's projects cannot be listed", async () => {
    const alice = connect("alice");
    const mallory = connect("mallory");
    await alice.subscribe("p1");
    await mallory.subscribe("p-mallory");

    db.deletedWorkspaces.add("ws1");
    db.listDown = true;
    await evictWorkspaceProjectRooms("ws1");
    expect(alice.inRoom("p1")).toBe(false);
    expect(mallory.inRoom("p-mallory")).toBe(true);
  });

  it("does not keep a join whose access read was in flight when the member was removed", async () => {
    let reached!: () => void;
    const atRead = new Promise<void>((r) => (reached = r));
    let release!: () => void;
    db.gate = { userId: "bob", opened: new Promise<void>((r) => (release = r)), reached };

    const bob = connect("bob");
    const subscribing = bob.subscribeLater("p1");
    // Bob's access read has taken its snapshot (a member); the removal commits
    // and evicts while his socket is not yet in the room.
    await atRead;
    db.members = db.members.filter((m) => m.userId !== "bob");
    await evictMemberProjectRooms("bob", "ws1");
    release();
    await subscribing;

    expect(bob.inRoom("p1")).toBe(false);
    expect(bob.refusals()).toEqual(DENIED);
  });
});

describe("#1212 — a legacy project assigned to a workspace", () => {
  it("drops a non-member subscribed before the move; the new workspace's member stays", async () => {
    const alice = connect("alice");
    const mallory = connect("mallory");
    await alice.subscribe("p-legacy");
    await mallory.subscribe("p-legacy");

    db.projects.find((p) => p.id === "p-legacy")!.workspaceId = "ws1";
    await evictProjectRoom("p-legacy");

    emitProgress("p-legacy");
    expect(mallory.jobs()).toEqual([]);
    expect(alice.jobs()).toHaveLength(1);
    expect(alice.inRoom("p-legacy")).toBe(true);
  });
});

describe("#1212 — the re-validation pass re-judges project rooms", () => {
  it("evicts a removed member whose eviction (or its relay) never arrived", async () => {
    const alice = connect("alice");
    const bob = connect("bob");
    await alice.subscribe("p1");
    await bob.subscribe("p1");

    db.members = db.members.filter((m) => m.userId !== "bob");
    await revalidateLocalSockets(io, "sweep");

    expect(bob.inRoom("p1")).toBe(false);
    expect(alice.inRoom("p1")).toBe(true);
  });

  it("keeps the room on a lookup error in a sweep; a LISTEN pass leaves it and closes the transport", async () => {
    const bob = connect("bob");
    await bob.subscribe("p1");

    db.failures = 1;
    await revalidateLocalSockets(io, "sweep");
    expect(bob.inRoom("p1")).toBe(true);
    expect(bob.closed()).toBe(0);

    // Closed so the client reconnects and re-subscribes from live state: a
    // member is re-admitted rather than silently left without updates.
    db.failures = 1;
    await revalidateLocalSockets(io, "listen");
    expect(bob.inRoom("p1")).toBe(false);
    expect(bob.closed()).toBe(1);
  });
});
