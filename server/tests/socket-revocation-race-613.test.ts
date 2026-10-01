/**
 * #613 — a revocation that lands between a socket's read of live state and its
 * room join must still reach the socket.
 *
 * - `subscribe:mcp` reads memberships, then joins. A workspace delete or member
 *   removal whose eviction ran inside that gap found the socket not yet in the
 *   room, so the socket joined the stale room and kept its events.
 * - The handshake reads the live user, but the socket joins `user:{id}` only on
 *   connect. A role change or deprovision whose `reconnectUserSockets` /
 *   `disconnectUserSockets` ran inside that gap missed the socket, which kept
 *   the stale role for the connection.
 *
 * Each test holds the read open with a gate, commits the revocation (the real
 * workspaces router, or the database change plus the real socket call the SCIM
 * routes make after it), then releases the read. Real Socket.IO server and
 * clients, the real `bootstrapMCP` emit path, Prisma mocked over an in-memory
 * table. Server vitest has `retry: 2`, so every gate, deferred and fixture is
 * created in the test body, per attempt.
 */
import http from "node:http";
import express, { type Express } from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}
interface Gate {
  read: "liveUser" | "workspaces";
  userId: string;
  reached: Deferred;
  release: Deferred;
  /** Reject the read once released, instead of returning its result. */
  fail?: boolean;
}

const db = vi.hoisted(() => ({
  /** `${workspaceId}:${userId}` → membership. */
  members: new Map<string, { workspaceId: string; userId: string }>(),
  deletedWorkspaces: new Set<string>(),
  /** projectId → workspaceId, for the MCP status emitter's project lookup. */
  projects: new Map<string, string>(),
  /** userId → durable role key. */
  roles: new Map<string, string>(),
  /** userIds whose account is no longer active. */
  inactive: new Set<string>(),
  /** Armed read gates; each is consumed by the first matching read. */
  gates: [] as Gate[],
  /** Calls to `loadLiveAuthPayload`, by user id. */
  liveUserReads: [] as string[],
}));

/** Run `read` to completion, then — if a gate is armed for it — hold its result. */
async function gated<T>(read: Gate["read"], userId: string, run: () => Promise<T>): Promise<T> {
  const result = await run();
  const i = db.gates.findIndex((g) => g.read === read && g.userId === userId);
  if (i === -1) return result;
  const [gate] = db.gates.splice(i, 1);
  gate.reached.resolve();
  await gate.release.promise;
  if (gate.fail) throw new Error("membership lookup failed");
  return result;
}

vi.mock("../src/lib/auth/live-workspace-ids.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/auth/live-workspace-ids.js")>();
  return {
    ...actual,
    readLiveWorkspaceIds: (userId: string) =>
      gated("workspaces", userId, () => actual.readLiveWorkspaceIds(userId)),
  };
});

vi.mock("../src/lib/auth/live-auth-payload.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/auth/live-auth-payload.js")>();
  return {
    loadLiveAuthPayload: (userId: string) => {
      db.liveUserReads.push(userId);
      return gated("liveUser", userId, () => actual.loadLiveAuthPayload(userId));
    },
  };
});

vi.mock("../src/lib/prisma.js", () => {
  const prisma = {
    user: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; status?: string } }) =>
        where.status === "active" && db.inactive.has(where.id)
          ? null
          : { id: where.id, username: where.id, authRoleAuthority: null },
      ),
    },
    userRole: {
      findMany: vi.fn(async ({ where }: { where: { userId: string } }) => {
        const key = db.roles.get(where.userId);
        return key ? [{ source: "local", role: { key } }] : [];
      }),
    },
    auditLog: { create: vi.fn(async () => ({})) },
    workspace: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        slug: where.id,
      })),
      update: vi.fn(async ({ where }: { where: { id: string } }) => {
        db.deletedWorkspaces.add(where.id);
        return { id: where.id };
      }),
    },
    workspaceMember: {
      findMany: vi.fn(
        async ({ where }: { where: { userId: string; workspace?: { deletedAt: null } } }) =>
          [...db.members.values()]
            .filter((m) => m.userId === where.userId)
            .filter(
              (m) =>
                !(where.workspace?.deletedAt === null && db.deletedWorkspaces.has(m.workspaceId)),
            )
            .map((m) => ({ workspaceId: m.workspaceId })),
      ),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const m = db.members.get(where.id);
        return m ? { id: where.id, ...m, role: "member" } : null;
      }),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        db.members.delete(where.id);
        return { id: where.id };
      }),
      count: vi.fn(async () => 1),
    },
    project: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const workspaceId = db.projects.get(where.id);
        return workspaceId ? { workspaceId } : null;
      }),
    },
    // #601 — workspace delete voids outstanding invites in the same interactive
    // transaction as the soft delete; run the callback against this mock.
    workspaceInvite: { updateMany: vi.fn(async () => ({ count: 0 })) },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
  };
  return { prisma };
});

vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));
vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import { createSocketServer, type MetisIOServer } from "../src/lib/socket/server.js";
import { registerSocketServer } from "../src/lib/socket/registry.js";
import { disconnectUserSockets, reconnectUserSockets } from "../src/lib/socket/user-disconnect.js";
import { issueTokens } from "../src/lib/auth/jwt.js";
import { bootstrapMCP, type MCPBootstrap } from "../src/lib/mcp/index.js";
import type { MCPServerConfig } from "../src/lib/mcp/types.js";
import { MCP_STATUS_ROOM, mcpStatusWorkspaceRoom } from "../src/lib/mcp/status-rooms.js";
import { workspacesRouter } from "../src/routes/workspaces.js";

let httpServer: http.Server;
let io: MetisIOServer;
let port: number;
let mcp: MCPBootstrap;
let app: Express;

beforeAll(async () => {
  httpServer = http.createServer();
  io = createSocketServer(httpServer);
  registerSocketServer(io);
  mcp = bootstrapMCP({ io, startHealthMonitor: false });
  await new Promise<void>((resolve) => {
    httpServer.listen(0, () => {
      const addr = httpServer.address();
      if (addr && typeof addr === "object") port = addr.port;
      resolve();
    });
  });
  // A system admin acts on the workspace (bypasses the workspace-role check).
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: object }).user = {
      userId: "u-acting-admin",
      role: "admin",
      workspaces: [],
    };
    next();
  });
  app.use("/workspaces", workspacesRouter());
});

afterAll(async () => {
  registerSocketServer(null as never);
  await mcp.shutdown();
  await io.close();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

const open: ClientSocket[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
});

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** Arm a gate on the next `read` of `userId`; created per attempt. */
function hold(read: Gate["read"], userId: string, opts: { fail?: boolean } = {}): Gate {
  const gate: Gate = { read, userId, reached: deferred(), release: deferred(), ...opts };
  db.gates.push(gate);
  return gate;
}

/** Let every continuation queued behind a released read run. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

const roomHas = (room: string, sid: string) =>
  io.sockets.adapter.rooms.get(room)?.has(sid) ?? false;

/** Seed the in-memory database for one test attempt. */
function seed(
  memberships: Array<[workspaceId: string, userId: string]>,
  roles: Record<string, string> = {},
): void {
  db.members = new Map(
    memberships.map(([workspaceId, userId]) => [
      `${workspaceId}:${userId}`,
      { workspaceId, userId },
    ]),
  );
  db.deletedWorkspaces = new Set();
  db.projects = new Map(
    [...new Set(memberships.map(([ws]) => ws))].map((ws) => [`p-${ws}`, ws] as const),
  );
  db.roles = new Map(Object.entries(roles));
  db.inactive = new Set();
  db.gates = [];
  db.liveUserReads = [];
}

interface Client {
  socket: ClientSocket;
  labels: string[];
  /** Every sid this client has held, in order — a reconnect appends one. */
  sids: string[];
  disconnectReasons: string[];
}

/**
 * Open a socket as the UI does (reconnection on). Resolves once the
 * connection is open — or, with `awaitConnect: false`, at once, so the caller
 * can hold the handshake's live-user read.
 */
async function connect(userId: string, { awaitConnect = true } = {}): Promise<Client> {
  // Coordinators hold `mcp.manage`, so a subscriber passes the room's role
  // gate unless the test seeded another role.
  if (!db.roles.has(userId)) db.roles.set(userId, "coordinator");
  const { accessToken } = issueTokens({
    userId,
    username: userId,
    role: "admin",
    permissions: [],
    workspaces: [],
  });
  const socket = ioClient(`http://127.0.0.1:${port}`, {
    auth: { token: accessToken },
    transports: ["websocket"],
    reconnectionDelay: 20,
    reconnectionDelayMax: 50,
    timeout: 2000,
  });
  open.push(socket);
  const client: Client = { socket, labels: [], sids: [], disconnectReasons: [] };
  socket.on("auth:ok", () => client.sids.push(socket.id!));
  socket.on("disconnect", (reason) => client.disconnectReasons.push(reason));
  socket.on("mcp:status", (e: { label: string }) => client.labels.push(e.label));
  if (awaitConnect) await vi.waitFor(() => expect(client.sids).toHaveLength(1));
  return client;
}

function projectServer(workspaceId: string, label: string): MCPServerConfig {
  return {
    id: label,
    scope: "project",
    projectId: `p-${workspaceId}`,
    userId: null,
    label,
    transport: "stdio",
    runtime: "native",
    command: "node",
    args: null,
    url: null,
    headers: null,
    env: null,
    envSecretRefs: null,
    trustLevel: "untrusted",
    defaultToolRisk: "medium",
    version: null,
    sha256: null,
    healthCheckIntervalSec: 60,
    enabled: false,
  };
}

/** Emit one project event per workspace, then a global sentinel every client gets. */
async function emitAndSettle(clients: Client[], workspaceIds: string[], tag: string) {
  for (const ws of workspaceIds) await mcp.lifecycle.start(projectServer(ws, `${ws}-${tag}`));
  const sentinel = `sentinel-${tag}`;
  await mcp.lifecycle.start({
    ...projectServer("none", sentinel),
    scope: "global",
    projectId: null,
  });
  await vi.waitFor(() => {
    for (const c of clients) expect(c.labels).toContain(sentinel);
  });
}

/** Emit `subscribe:mcp` with the membership read held; resolves once it is held. */
async function subscribeHeld(client: Client, userId: string): Promise<Gate> {
  const gate = hold("workspaces", userId);
  client.socket.emit("subscribe:mcp");
  await gate.reached.promise;
  return gate;
}

describe("#613 subscribe:mcp — an eviction between the membership read and the join", () => {
  it("a member removed while the read is held does not end up in the workspace's room", async () => {
    seed([
      ["ws-a", "u-removed"],
      ["ws-b", "u-removed"],
    ]);
    const c = await connect("u-removed");
    const sid = c.sids[0];
    const read = await subscribeHeld(c, "u-removed");

    // Commit the removal and run its eviction — while the socket is in no room.
    const res = await request(app).delete("/workspaces/ws-a/members/ws-a:u-removed");
    expect(res.status).toBe(200);
    read.release.resolve();

    await vi.waitFor(() => expect(roomHas(MCP_STATUS_ROOM, sid)).toBe(true));
    await vi.waitFor(() => expect(roomHas(mcpStatusWorkspaceRoom("ws-a"), sid)).toBe(false));
    expect(roomHas(mcpStatusWorkspaceRoom("ws-b"), sid)).toBe(true);

    await emitAndSettle([c], ["ws-a", "ws-b"], "removed");
    expect(c.labels).not.toContain("ws-a-removed");
    expect(c.labels).toContain("ws-b-removed");
  });

  it("a workspace deleted while the read is held does not end up in its room", async () => {
    seed([
      ["ws-c", "u-member"],
      ["ws-d", "u-member"],
    ]);
    const c = await connect("u-member");
    const sid = c.sids[0];
    const read = await subscribeHeld(c, "u-member");

    const res = await request(app).delete("/workspaces/ws-c");
    expect(res.status).toBe(200);
    read.release.resolve();

    await vi.waitFor(() => expect(roomHas(MCP_STATUS_ROOM, sid)).toBe(true));
    await vi.waitFor(() =>
      expect(io.sockets.adapter.rooms.get(mcpStatusWorkspaceRoom("ws-c"))).toBeUndefined(),
    );
    expect(roomHas(mcpStatusWorkspaceRoom("ws-d"), sid)).toBe(true);

    await emitAndSettle([c], ["ws-c", "ws-d"], "deleted");
    expect(c.labels).not.toContain("ws-c-deleted");
    expect(c.labels).toContain("ws-d-deleted");
  });

  it("an unrelated eviction during the read keeps the rooms the user still holds", async () => {
    seed([
      ["ws-e", "u-stays"],
      ["ws-e", "u-other"],
    ]);
    const c = await connect("u-stays");
    const sid = c.sids[0];
    const read = await subscribeHeld(c, "u-stays");

    // Another user leaves the same workspace: the epoch moves, the re-read
    // still lists ws-e for this user.
    const res = await request(app).delete("/workspaces/ws-e/members/ws-e:u-other");
    expect(res.status).toBe(200);
    read.release.resolve();

    await vi.waitFor(() => expect(roomHas(mcpStatusWorkspaceRoom("ws-e"), sid)).toBe(true));
    await settle();
    expect(roomHas(mcpStatusWorkspaceRoom("ws-e"), sid)).toBe(true);
    await emitAndSettle([c], ["ws-e"], "unrelated");
    expect(c.labels).toContain("ws-e-unrelated");
  });

  it("no eviction during the read means no second membership read", async () => {
    seed([["ws-f", "u-quiet"]]);
    const c = await connect("u-quiet");
    const sid = c.sids[0];
    const findMany = vi.mocked(
      (await import("../src/lib/prisma.js")).prisma.workspaceMember.findMany,
    );
    const before = findMany.mock.calls.length;
    c.socket.emit("subscribe:mcp");
    await vi.waitFor(() => expect(roomHas(mcpStatusWorkspaceRoom("ws-f"), sid)).toBe(true));
    await settle();
    expect(findMany.mock.calls.length - before).toBe(1);
  });

  it("a failed re-read leaves every workspace room (fail closed)", async () => {
    seed([
      ["ws-g", "u-failed"],
      ["ws-g", "u-evicted"],
    ]);
    const c = await connect("u-failed");
    const sid = c.sids[0];
    const read = await subscribeHeld(c, "u-failed");
    const reRead = hold("workspaces", "u-failed", { fail: true });

    expect((await request(app).delete("/workspaces/ws-g/members/ws-g:u-evicted")).status).toBe(200);
    read.release.resolve();
    await reRead.reached.promise;
    expect(roomHas(mcpStatusWorkspaceRoom("ws-g"), sid)).toBe(true);
    reRead.release.resolve();

    await vi.waitFor(() => expect(roomHas(mcpStatusWorkspaceRoom("ws-g"), sid)).toBe(false));
    expect(roomHas(MCP_STATUS_ROOM, sid)).toBe(true);
  });

  it("a re-read overtaken by a newer subscribe does not undo the newer one's join", async () => {
    seed([
      ["ws-h", "u-resub"],
      ["ws-h", "u-left"],
    ]);
    const c = await connect("u-resub");
    const sid = c.sids[0];
    const read = await subscribeHeld(c, "u-resub");
    const reRead = hold("workspaces", "u-resub");

    expect((await request(app).delete("/workspaces/ws-h/members/ws-h:u-left")).status).toBe(200);
    read.release.resolve();
    await reRead.reached.promise; // stale: read before the new membership below

    db.members.set("ws-i:u-resub", { workspaceId: "ws-i", userId: "u-resub" });
    db.projects.set("p-ws-i", "ws-i");
    c.socket.emit("subscribe:mcp");
    await vi.waitFor(() => expect(roomHas(mcpStatusWorkspaceRoom("ws-i"), sid)).toBe(true));

    reRead.release.resolve();
    await settle();
    expect(roomHas(mcpStatusWorkspaceRoom("ws-i"), sid)).toBe(true);
  });
});

describe("#613 handshake — a revocation between the live-user read and the user-room join", () => {
  it("a role change committed while the read is held re-handshakes with the new role", async () => {
    seed([], { "u-demoted": "admin" });
    const read = hold("liveUser", "u-demoted");
    const c = await connect("u-demoted", { awaitConnect: false });
    await read.reached.promise;

    // The SCIM route's order: commit the role, then reconnect the user's sockets.
    db.roles.set("u-demoted", "reader");
    reconnectUserSockets("u-demoted");
    read.release.resolve();

    await vi.waitFor(() => {
      expect(c.disconnectReasons).toEqual(["transport close"]);
      expect(c.sids).toHaveLength(2);
      expect(c.socket.connected).toBe(true);
    });
    expect(io.sockets.sockets.has(c.sids[0])).toBe(false);
    expect(io.sockets.sockets.get(c.sids[1])?.data.user.role).toBe("reader");
  });

  it("a deprovision committed while the read is held disconnects the socket", async () => {
    seed([], { "u-gone": "admin" });
    const read = hold("liveUser", "u-gone");
    const c = await connect("u-gone", { awaitConnect: false });
    await read.reached.promise;

    db.inactive.add("u-gone");
    disconnectUserSockets("u-gone");
    read.release.resolve();

    await vi.waitFor(() => expect(c.disconnectReasons).toEqual(["io server disconnect"]));
    expect(c.sids).toHaveLength(1);
    expect(io.sockets.sockets.has(c.sids[0])).toBe(false);
  });

  it("a failed re-read closes the transport so the client re-handshakes (fail closed, recoverable)", async () => {
    seed([], { "u-lookup": "admin" });
    const read = hold("liveUser", "u-lookup");
    const c = await connect("u-lookup", { awaitConnect: false });
    await read.reached.promise;
    const reRead = hold("liveUser", "u-lookup", { fail: true });

    reconnectUserSockets("u-someone-else");
    read.release.resolve();
    await reRead.reached.promise;
    reRead.release.resolve();

    // Not `io server disconnect`, which the client treats as final: a transient
    // lookup failure must not park a legitimate user until they reload.
    await vi.waitFor(() => {
      expect(c.disconnectReasons).toEqual(["transport close"]);
      expect(c.sids).toHaveLength(2);
      expect(c.socket.connected).toBe(true);
    });
    expect(io.sockets.sockets.has(c.sids[0])).toBe(false);
    // The reconnect went through a fresh handshake read of the live user.
    expect(db.liveUserReads).toEqual(["u-lookup", "u-lookup", "u-lookup"]);
  });

  it("a re-read that succeeds and finds the user inactive disconnects for good", async () => {
    seed([], { "u-lapsed": "admin" });
    const read = hold("liveUser", "u-lapsed");
    const c = await connect("u-lapsed", { awaitConnect: false });
    await read.reached.promise;

    // The handshake read already returned a live user; the account lapses
    // after it, and an unrelated revocation moves the epoch.
    db.inactive.add("u-lapsed");
    reconnectUserSockets("u-someone-else");
    read.release.resolve();

    await vi.waitFor(() => expect(c.disconnectReasons).toEqual(["io server disconnect"]));
    await settle();
    expect(c.sids).toHaveLength(1);
    expect(c.socket.connected).toBe(false);
    expect(db.liveUserReads).toEqual(["u-lapsed", "u-lapsed"]);
  });

  it("another user's revocation during the read re-reads but leaves the socket alone", async () => {
    seed([], { "u-steady": "admin" });
    const read = hold("liveUser", "u-steady");
    const c = await connect("u-steady", { awaitConnect: false });
    await read.reached.promise;

    reconnectUserSockets("u-someone-else");
    read.release.resolve();

    await vi.waitFor(() => expect(db.liveUserReads).toEqual(["u-steady", "u-steady"]));
    await settle();
    expect(c.disconnectReasons).toEqual([]);
    expect(c.sids).toHaveLength(1);
    expect(io.sockets.sockets.get(c.sids[0])?.data.user.role).toBe("admin");
  });

  it("no revocation during the read means no second live-user read", async () => {
    seed([], { "u-plain": "admin" });
    const c = await connect("u-plain");
    await settle();
    expect(db.liveUserReads).toEqual(["u-plain"]);
    expect(c.disconnectReasons).toEqual([]);
  });
});
