/**
 * #1212 — the `project:{id}` socket room admits every user who can open the
 * project (`assertProjectAccess`), not only its creator, and lets go of a
 * member removed from the workspace.
 *
 * One workspace (`ws1`) holds project `p1` and two analysts: Alice, who
 * created the project, and Bob, who did not. Mallory is an authenticated user
 * in another workspace (`ws2`). Nothing on the access path is mocked: the real
 * Socket.IO server and handshake, `subscribe:project` → `canJoinProjectRoom` →
 * `canAccessProjectDiscussions` → `assertProjectAccess`, the real job-event
 * emitter, and the real eviction module all run. Only the database is a double:
 * an in-memory model of the rows those read, whose `project.findMany` honours
 * `createdById`, so the scheduler's creator-only rule — were it restored —
 * would admit Alice alone and these tests would fail on Bob.
 */
import http from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import type { JobLifecycleEvent, SocketAuthErrorEvent } from "@metis/shared";

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
  /** When true, the live-project read fails (a database outage). */
  down: false,
}));

const audit = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/audit/audit-service.js", () => ({
  audit: (...args: unknown[]) => audit(...args),
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    $queryRawUnsafe: vi.fn(async () => 1),
    auditLog: { create: vi.fn(async () => ({})) },
    // The handshake's live-user read: everyone is an active user.
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
        if (db.down) throw new Error("db down");
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
      findMany: vi.fn(async ({ where }: { where: Where }) =>
        db.projects
          .filter((p) =>
            Object.entries(where).every(([k, v]) =>
              k === "deletedAt" ? v !== null || p.deletedAt === null : p[k as keyof typeof p] === v,
            ),
          )
          .map((p) => ({ id: p.id })),
      ),
    },
  },
}));

import { createSocketServer, type MetisIOServer } from "../src/lib/socket/server.js";
import { createJobEventEmitter, _resetJobLifecycleMemory } from "../src/lib/socket/job-events.js";
import {
  evictMemberProjectRooms,
  evictWorkspaceProjectRooms,
} from "../src/lib/socket/project-room-eviction.js";
import { registerSocketServer } from "../src/lib/socket/registry.js";
import { issueTokens } from "../src/lib/auth/jwt.js";

let httpServer: http.Server;
let io: MetisIOServer;
let port: number;
const open: ClientSocket[] = [];

beforeAll(async () => {
  httpServer = http.createServer();
  io = createSocketServer(httpServer);
  registerSocketServer(io);
  await new Promise<void>((resolve) => {
    httpServer.listen(0, () => {
      const addr = httpServer.address();
      if (addr && typeof addr === "object") port = addr.port;
      resolve();
    });
  });
});

afterAll(async () => {
  registerSocketServer(null as unknown as MetisIOServer);
  await io.close();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

beforeEach(() => {
  db.members = [
    { userId: "alice", workspaceId: "ws1" },
    { userId: "bob", workspaceId: "ws1" },
    { userId: "mallory", workspaceId: "ws2" },
  ];
  db.projects = [
    { id: "p1", workspaceId: "ws1", createdById: "alice", deletedAt: null },
    { id: "p-mallory", workspaceId: "ws2", createdById: "mallory", deletedAt: null },
    { id: "p-gone", workspaceId: "ws1", createdById: "bob", deletedAt: new Date() },
  ];
  db.deletedWorkspaces.clear();
  db.roles.clear();
  db.gate = null;
  db.down = false;
  audit.mockClear();
  _resetJobLifecycleMemory();
});

afterEach(() => {
  for (const socket of open.splice(0)) socket.close();
});

/** A connected socket for `userId`, recording its job events and refusals. */
async function connect(userId: string) {
  const { accessToken } = issueTokens({
    userId,
    username: userId,
    role: "developer",
    permissions: [],
  });
  const socket = ioClient(`http://127.0.0.1:${port}`, {
    auth: { token: accessToken },
    transports: ["websocket"],
    reconnection: false,
    timeout: 1500,
  });
  open.push(socket);
  const jobs: JobLifecycleEvent[] = [];
  const refusals: SocketAuthErrorEvent[] = [];
  socket.on("job:lifecycle", (e) => jobs.push(e));
  socket.on("auth:error", (e) => refusals.push(e));
  await new Promise<void>((resolve, reject) => {
    socket.on("auth:ok", () => resolve());
    socket.on("connect_error", reject);
  });
  return { socket, jobs, refusals };
}

const settle = () => new Promise((r) => setTimeout(r, 60));
const roomSize = (projectId: string) =>
  io.sockets.adapter.rooms.get(`project:${projectId}`)?.size ?? 0;
const emitProgress = (projectId = "p1") =>
  createJobEventEmitter(io).progress("analysis", "job-1", projectId, 40, "Analysing");

describe("#1212 — subscribe:project admits every project member", () => {
  it("both workspace members receive a job-progress event — including Bob, who did not create the project", async () => {
    const alice = await connect("alice");
    const bob = await connect("bob");
    alice.socket.emit("subscribe:project", { projectId: "p1" });
    bob.socket.emit("subscribe:project", { projectId: "p1" });
    await settle();

    expect(bob.refusals).toEqual([]);
    expect(roomSize("p1")).toBe(2);

    emitProgress();
    await settle();
    for (const member of [alice, bob]) {
      expect(member.jobs).toEqual([
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
    const alice = await connect("alice");
    const mallory = await connect("mallory");
    alice.socket.emit("subscribe:project", { projectId: "p1" });
    mallory.socket.emit("subscribe:project", { projectId: "p1" });
    await settle();

    expect(mallory.refusals).toEqual([{ message: "FORBIDDEN: no access to project" }]);
    expect(roomSize("p1")).toBe(1);
    emitProgress();
    await settle();
    expect(mallory.jobs).toEqual([]);
    expect(alice.jobs).toHaveLength(1);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { id: "mallory" },
        action: "socket.subscribe:project.denied",
        target: { type: "project_room", id: "p1" },
      }),
    );
  });

  it("refuses a project that exists exactly as one that does not, so a join is no existence oracle", async () => {
    const mallory = await connect("mallory");
    mallory.socket.emit("subscribe:project", { projectId: "p1" });
    await settle();
    mallory.socket.emit("subscribe:project", { projectId: "p-does-not-exist" });
    await settle();
    expect(mallory.refusals).toHaveLength(2);
    expect(mallory.refusals[0]).toEqual(mallory.refusals[1]);
  });

  it("refuses a member a soft-deleted project of their own workspace", async () => {
    const bob = await connect("bob");
    bob.socket.emit("subscribe:project", { projectId: "p-gone" });
    await settle();
    expect(bob.refusals).toEqual([{ message: "FORBIDDEN: no access to project" }]);
    expect(roomSize("p-gone")).toBe(0);
  });

  it("admits an admin to a project in a workspace they do not belong to", async () => {
    db.roles.set("root", "admin");
    const root = await connect("root");
    root.socket.emit("subscribe:project", { projectId: "p1" });
    await settle();
    expect(root.refusals).toEqual([]);
    expect(roomSize("p1")).toBe(1);
  });

  it("fails closed when the access read errors, taking a socket already in the room out of it", async () => {
    const alice = await connect("alice");
    alice.socket.emit("subscribe:project", { projectId: "p1" });
    await settle();
    expect(roomSize("p1")).toBe(1);

    db.down = true;
    alice.socket.emit("subscribe:project", { projectId: "p1" });
    await settle();
    expect(alice.refusals).toEqual([{ message: "FORBIDDEN: no access to project" }]);
    expect(roomSize("p1")).toBe(0);
  });

  it("refuses the project's creator once they have left its workspace", async () => {
    db.members = db.members.filter((m) => m.userId !== "alice");
    const alice = await connect("alice");
    alice.socket.emit("subscribe:project", { projectId: "p1" });
    await settle();
    expect(alice.refusals).toEqual([{ message: "FORBIDDEN: no access to project" }]);
    expect(roomSize("p1")).toBe(0);
  });
});

describe("#1212 — a member removed from the workspace stops receiving the room's events", () => {
  it("evicts the removed member's open sockets; the remaining member keeps receiving", async () => {
    const alice = await connect("alice");
    const bob = await connect("bob");
    alice.socket.emit("subscribe:project", { projectId: "p1" });
    bob.socket.emit("subscribe:project", { projectId: "p1" });
    await settle();
    expect(roomSize("p1")).toBe(2);

    db.members = db.members.filter((m) => m.userId !== "bob");
    await evictMemberProjectRooms("bob", "ws1");
    await settle();

    emitProgress();
    await settle();
    expect(bob.jobs).toEqual([]);
    expect(alice.jobs).toHaveLength(1);

    // And a re-subscribe is refused.
    bob.socket.emit("subscribe:project", { projectId: "p1" });
    await settle();
    expect(bob.refusals).toEqual([{ message: "FORBIDDEN: no access to project" }]);
    expect(roomSize("p1")).toBe(1);
  });

  it("leaves the removed member in rooms of other workspaces' projects", async () => {
    db.members.push({ userId: "bob", workspaceId: "ws2" });
    const bob = await connect("bob");
    bob.socket.emit("subscribe:project", { projectId: "p1" });
    bob.socket.emit("subscribe:project", { projectId: "p-mallory" });
    await settle();
    expect(roomSize("p-mallory")).toBe(1);

    db.members = db.members.filter((m) => !(m.userId === "bob" && m.workspaceId === "ws1"));
    await evictMemberProjectRooms("bob", "ws1");
    await settle();
    expect(roomSize("p1")).toBe(0);
    expect(roomSize("p-mallory")).toBe(1);
  });

  it("empties the project rooms of a deleted workspace", async () => {
    const alice = await connect("alice");
    const bob = await connect("bob");
    alice.socket.emit("subscribe:project", { projectId: "p1" });
    bob.socket.emit("subscribe:project", { projectId: "p1" });
    await settle();

    db.deletedWorkspaces.add("ws1");
    await evictWorkspaceProjectRooms("ws1");
    await settle();
    emitProgress();
    await settle();
    expect(roomSize("p1")).toBe(0);
    expect(alice.jobs).toEqual([]);
    expect(bob.jobs).toEqual([]);
  });

  it("does not keep a join whose access read was in flight when the member was removed", async () => {
    let reached!: () => void;
    const atRead = new Promise<void>((r) => (reached = r));
    let release!: () => void;
    db.gate = { userId: "bob", opened: new Promise<void>((r) => (release = r)), reached };

    const bob = await connect("bob");
    bob.socket.emit("subscribe:project", { projectId: "p1" });
    // Bob's access read has taken its snapshot (a member); the removal commits
    // and evicts while his socket is not yet in the room.
    await atRead;
    db.members = db.members.filter((m) => m.userId !== "bob");
    await evictMemberProjectRooms("bob", "ws1");
    release();
    await settle();

    expect(roomSize("p1")).toBe(0);
    expect(bob.refusals).toEqual([{ message: "FORBIDDEN: no access to project" }]);
  });
});
