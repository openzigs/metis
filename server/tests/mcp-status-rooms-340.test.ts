/**
 * #340 — a `scope: "user"` MCP server's `mcp:status` events reach ONLY its
 * owner and system admins.
 * #353 — a `scope: "project"` server's events reach ONLY users who can access
 * the project (`assertProjectAccess`): its workspace's members and admins, or
 * everyone when the project has no workspace.
 *
 * Real Socket.IO server, real clients, and the real `bootstrapMCP` emit path:
 * a server is started with `enabled: false`, which makes the lifecycle manager
 * emit a `disabled` status without any transport. Coordinators hold
 * `mcp.manage`, so every subscriber below passes the room's role gate — what is
 * under test is which events each one receives.
 */
import http from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";

// #562 — holds u-slow's membership lookup open until the race test releases
// it. The race test creates the gate per attempt, never here: server vitest
// has `retry: 2`, and a module-scoped one-shot gate would already be open on a
// retry, so the retry would no longer exercise the race.
const slowMembership = vi.hoisted(() => ({
  gate: null as { promise: Promise<void>; release: () => void } | null,
}));

/**
 * #617 — the handshake's live-user read is covered by `socket.test.ts` and the
 * #612 SCIM test; here every user is live with the role the test connects as,
 * so the membership lookups below are only `subscribe:mcp`'s.
 */
const liveRoles = vi.hoisted(() => new Map<string, "admin" | "coordinator">());
vi.mock("../src/lib/auth/live-auth-payload.js", () => ({
  loadLiveAuthPayload: vi.fn(async (userId: string) => ({
    userId,
    username: userId,
    role: liveRoles.get(userId) ?? "coordinator",
    permissions: [],
    workspaces: [],
  })),
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    $queryRawUnsafe: vi.fn(async () => 1),
    user: { upsert: vi.fn() },
    userRole: { findFirst: vi.fn(async () => null) },
    auditLog: { create: vi.fn(async () => ({})) },
    // #562 — memberships as the database holds them, which the `mcp:status`
    // workspace rooms are joined from (not the token's `workspaces` claim).
    // `ws-deleted` is soft-deleted; the mock honours the live-workspace filter,
    // so a query that drops it would hand back the deleted workspace.
    workspaceMember: {
      findMany: vi.fn(
        async ({ where }: { where: { userId: string; workspace?: { deletedAt: null } } }) => {
          if (where.userId === "u-db-down") throw new Error("db down");
          if (where.userId === "u-slow") {
            if (!slowMembership.gate) throw new Error("u-slow lookup without a gate");
            await slowMembership.gate.promise;
            return [{ workspaceId: "ws1" }];
          }
          const rows = [
            { userId: "u-member", workspaceId: "ws1", deleted: false },
            { userId: "u-outsider", workspaceId: "ws2", deleted: false },
            { userId: "u-stale", workspaceId: "ws-deleted", deleted: true },
            { userId: "u-late", workspaceId: "ws1", deleted: false },
          ];
          return rows
            .filter((r) => r.userId === where.userId)
            .filter((r) => !(where.workspace?.deletedAt === null && r.deleted))
            .map((r) => ({ workspaceId: r.workspaceId }));
        },
      ),
    },
    project: {
      findMany: vi.fn(async () => []),
      // #353 fixtures: p-ws1 lives in ws1, p-legacy has no workspace, anything
      // else does not exist, and p-boom's lookup throws.
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        if (where.id === "p-boom") throw new Error("db down");
        if (where.id === "p-ws1") return { workspaceId: "ws1" };
        if (where.id === "p-wsdel") return { workspaceId: "ws-deleted" };
        if (where.id === "p-ws2") return { workspaceId: "ws2" };
        if (where.id === "p-legacy") return { workspaceId: null };
        return null;
      }),
    },
  },
}));

import { prisma } from "../src/lib/prisma.js";
import { createSocketServer, type MetisIOServer } from "../src/lib/socket/server.js";
import { issueTokens } from "../src/lib/auth/jwt.js";
import { bootstrapMCP, type MCPBootstrap } from "../src/lib/mcp/index.js";
import type { MCPServerConfig } from "../src/lib/mcp/types.js";
import {
  MCP_STATUS_ADMIN_ROOM,
  MCP_STATUS_ROOM,
  createMcpStatusEmitter,
  MCP_STATUS_LOOKUP_TIMEOUT_MS,
  mcpStatusOwnerRoom,
  mcpStatusRooms,
  mcpStatusRoomsFor,
  mcpStatusWorkspaceRoom,
} from "../src/lib/mcp/status-rooms.js";

let httpServer: http.Server;
let io: MetisIOServer;
let port: number;
let mcp: MCPBootstrap;

beforeAll(async () => {
  httpServer = http.createServer();
  io = createSocketServer(httpServer);
  mcp = bootstrapMCP({ io, startHealthMonitor: false });
  await new Promise<void>((resolve) => {
    httpServer.listen(0, () => {
      const addr = httpServer.address();
      if (addr && typeof addr === "object") port = addr.port;
      resolve();
    });
  });
});

afterAll(async () => {
  await mcp.shutdown();
  await io.close();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

interface Subscriber {
  socket: ClientSocket;
  labels: string[];
  /** This client's socket id on the SERVER. */
  sid: string;
}

// Closed after every test (a failed assertion included), so no socket outlives
// its test and joins the next one's rooms.
const open: ClientSocket[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
});

const roomHas = (room: string, sid: string) =>
  io.sockets.adapter.rooms.get(room)?.has(sid) ?? false;

/** A server socket as seen by a test that adds an acked event of its own. */
interface BarrierSocket {
  on(event: string, listener: (ack: () => void) => void): void;
}

async function subscribe(
  userId: string,
  role: "admin" | "coordinator",
  workspaces: string[] = [],
): Promise<Subscriber> {
  liveRoles.set(userId, role);
  const { accessToken } = issueTokens({
    userId,
    username: userId,
    role,
    permissions: [],
    workspaces,
  });
  const socket = ioClient(`http://127.0.0.1:${port}`, {
    auth: { token: accessToken },
    transports: ["websocket"],
    reconnection: false,
    timeout: 2000,
  });
  open.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.on("auth:ok", () => resolve());
    socket.on("connect_error", reject);
  });
  const sid = socket.id!;
  const sub: Subscriber = { socket, labels: [], sid };
  socket.on("mcp:status", (e: { label: string }) => sub.labels.push(e.label));
  socket.emit("subscribe:mcp");
  // The join is async on the server; wait until this socket is in the shared room.
  await vi.waitFor(() => expect(roomHas(MCP_STATUS_ROOM, sid)).toBe(true));
  return sub;
}

function config(over: Partial<MCPServerConfig>): MCPServerConfig {
  return {
    id: "srv",
    scope: "global",
    projectId: null,
    userId: null,
    label: "srv",
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
    ...over,
  };
}

describe("#340 mcp:status — user-scope events reach only the owner and admins", () => {
  it("routes each scope's events to the right subscribers", async () => {
    const owner = await subscribe("u-owner", "coordinator");
    const peer = await subscribe("u-peer", "coordinator");
    const admin = await subscribe("u-admin", "admin");

    await mcp.lifecycle.start(config({ id: "g", label: "global-srv" }));
    await mcp.lifecycle.start(
      config({ id: "p", label: "project-srv", scope: "project", projectId: "p-legacy" }),
    );
    await mcp.lifecycle.start(
      config({ id: "u", label: "owner-srv", scope: "user", userId: "u-owner" }),
    );
    await mcp.lifecycle.start(
      config({ id: "o", label: "orphan-srv", scope: "user", userId: null }),
    );
    // A trailing global event: once every subscriber has it, every earlier
    // event that was going to reach them has arrived (one connection, in order).
    await mcp.lifecycle.start(config({ id: "z", label: "sentinel" }));
    await vi.waitFor(() => {
      for (const s of [owner, peer, admin]) expect(s.labels).toContain("sentinel");
    });

    // Global events, and a no-workspace project's: every mcp.manage subscriber.
    for (const s of [owner, peer, admin]) {
      expect(s.labels).toContain("global-srv");
      expect(s.labels).toContain("project-srv");
    }
    // The owner's server: its owner and the admin, never the peer.
    expect(owner.labels).toContain("owner-srv");
    expect(admin.labels).toContain("owner-srv");
    expect(peer.labels).not.toContain("owner-srv");
    // An ownerless user server: admins only (fail closed).
    expect(admin.labels).toContain("orphan-srv");
    expect(owner.labels).not.toContain("orphan-srv");
    expect(peer.labels).not.toContain("orphan-srv");
    // Each event delivered once, even to a socket in two of its rooms.
    expect(admin.labels.filter((l) => l === "owner-srv")).toHaveLength(1);
  });

  it("unsubscribe:mcp leaves every mcp status room", async () => {
    const admin = await subscribe("u-admin2", "admin");
    const rooms = mcpStatusRoomsFor({ userId: "u-admin2", role: "admin" });
    await vi.waitFor(() => {
      for (const room of rooms) expect(roomHas(room, admin.sid), room).toBe(true);
    });
    admin.socket.emit("unsubscribe:mcp");
    await vi.waitFor(() => {
      for (const room of rooms) expect(roomHas(room, admin.sid), room).toBe(false);
    });
  });
});

describe("#340 mcpStatusRooms / mcpStatusRoomsFor", () => {
  it("never sends a user-scope event to the shared room", () => {
    expect(mcpStatusRooms({ scope: "global" })).toEqual([MCP_STATUS_ROOM]);
    expect(mcpStatusRooms({ scope: "user" }, { ownerId: "u1" })).toEqual([
      mcpStatusOwnerRoom("u1"),
      MCP_STATUS_ADMIN_ROOM,
    ]);
    expect(mcpStatusRooms({ scope: "user" }, { ownerId: null })).toEqual([MCP_STATUS_ADMIN_ROOM]);
  });

  it("puts only admins in the admin room", () => {
    expect(mcpStatusRoomsFor({ userId: "u1", role: "coordinator" })).toEqual([
      MCP_STATUS_ROOM,
      mcpStatusOwnerRoom("u1"),
    ]);
    expect(mcpStatusRoomsFor({ userId: "a", role: "admin" })).toContain(MCP_STATUS_ADMIN_ROOM);
  });
});

describe("#353 mcp:status — project-scope events reach only users who can access the project", () => {
  it("a workspace project's events reach its members and admins, never another workspace", async () => {
    const member = await subscribe("u-member", "coordinator", ["ws1"]);
    const outsider = await subscribe("u-outsider", "coordinator", ["ws2"]);
    const noWs = await subscribe("u-nows", "coordinator");
    const admin = await subscribe("u-admin3", "admin");
    const all = [member, outsider, noWs, admin];

    await mcp.lifecycle.start(
      config({ id: "pw", label: "ws1-srv", scope: "project", projectId: "p-ws1" }),
    );
    await mcp.lifecycle.start(
      config({ id: "pl", label: "legacy-srv", scope: "project", projectId: "p-legacy" }),
    );
    await mcp.lifecycle.start(
      config({ id: "pm", label: "missing-srv", scope: "project", projectId: "p-missing" }),
    );
    await mcp.lifecycle.start(
      config({ id: "pb", label: "boom-srv", scope: "project", projectId: "p-boom" }),
    );
    await mcp.lifecycle.start(config({ id: "pn", label: "noproj-srv", scope: "project" }));
    await mcp.lifecycle.start(config({ id: "z2", label: "sentinel-353" }));
    await vi.waitFor(() => {
      for (const s of all) expect(s.labels).toContain("sentinel-353");
    });

    // The workspace's member and the admin see it; nobody else does.
    expect(member.labels).toContain("ws1-srv");
    expect(admin.labels).toContain("ws1-srv");
    expect(outsider.labels).not.toContain("ws1-srv");
    expect(noWs.labels).not.toContain("ws1-srv");
    expect(admin.labels.filter((l) => l === "ws1-srv")).toHaveLength(1);
    // A project with no workspace is open to every authenticated user.
    for (const s of all) expect(s.labels).toContain("legacy-srv");
    // Unknown project, failed lookup, no project id: admins only (fail closed).
    for (const label of ["missing-srv", "boom-srv", "noproj-srv"]) {
      expect(admin.labels, label).toContain(label);
      for (const s of [member, outsider, noWs]) expect(s.labels, label).not.toContain(label);
    }
    // Queued behind async lookups, events still arrive in emit order.
    expect(admin.labels.slice(-6)).toEqual([
      "ws1-srv",
      "legacy-srv",
      "missing-srv",
      "boom-srv",
      "noproj-srv",
      "sentinel-353",
    ]);
  });

  it("puts a subscriber in one room per live workspace", () => {
    expect(mcpStatusRoomsFor({ userId: "u1", role: "coordinator" }, ["a", "b"])).toEqual([
      MCP_STATUS_ROOM,
      mcpStatusOwnerRoom("u1"),
      mcpStatusWorkspaceRoom("a"),
      mcpStatusWorkspaceRoom("b"),
    ]);
  });

  it("routes project events by the project's workspace", () => {
    expect(mcpStatusRooms({ scope: "project" }, { project: { workspaceId: "w" } })).toEqual([
      mcpStatusWorkspaceRoom("w"),
      MCP_STATUS_ADMIN_ROOM,
    ]);
    expect(mcpStatusRooms({ scope: "project" }, { project: { workspaceId: null } })).toEqual([
      MCP_STATUS_ROOM,
    ]);
    expect(mcpStatusRooms({ scope: "project" }, { project: null })).toEqual([
      MCP_STATUS_ADMIN_ROOM,
    ]);
    expect(mcpStatusRooms({ scope: "project" })).toEqual([MCP_STATUS_ADMIN_ROOM]);
  });

  it("a slow project lookup does not let a later event overtake it", async () => {
    const emitted: string[] = [];
    const sink = {
      to: (rooms: string[]) => ({
        emit: (_ev: "mcp:status", e: { label: string }) => {
          emitted.push(`${e.label}@${rooms.join(",")}`);
        },
      }),
    };
    const { emit, drain } = createMcpStatusEmitter(sink, async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { workspaceId: "w" };
    });
    emit({
      serverId: "p",
      label: "p",
      scope: "project",
      projectId: "p1",
      status: "ready",
      latencyMs: null,
      failureCount: 0,
      lastError: null,
      ts: 0,
    });
    emit({
      serverId: "g",
      label: "g",
      scope: "global",
      projectId: null,
      status: "ready",
      latencyMs: null,
      failureCount: 0,
      lastError: null,
      ts: 0,
    });
    await drain();
    await vi.waitFor(() => expect(emitted).toHaveLength(2));
    expect(emitted).toEqual([
      `p@${mcpStatusWorkspaceRoom("w")},${MCP_STATUS_ADMIN_ROOM}`,
      `g@${MCP_STATUS_ROOM}`,
    ]);
  });

  it("a throwing sink does not stall later events", async () => {
    const emitted: string[] = [];
    const errors: string[] = [];
    let first = true;
    const sink = {
      to: (rooms: string[]) => ({
        emit: (_ev: "mcp:status", e: { label: string }) => {
          if (first) {
            first = false;
            throw new Error("sink down");
          }
          emitted.push(`${e.label}@${rooms.join(",")}`);
        },
      }),
    };
    const { emit, drain } = createMcpStatusEmitter(
      sink,
      async () => null,
      (err) => errors.push((err as Error).message),
    );
    const ev = (label: string) => ({
      serverId: label,
      label,
      scope: "global" as const,
      projectId: null,
      status: "ready" as const,
      latencyMs: null,
      failureCount: 0,
      lastError: null,
      ts: 0,
    });
    emit(ev("a"));
    emit(ev("b"));
    await drain();
    expect(errors).toEqual(["sink down"]);
    expect(emitted).toEqual([`b@${MCP_STATUS_ROOM}`]);
  });

  describe("#360 a hung project lookup is bounded", () => {
    afterEach(() => vi.useRealTimers());

    const event = (label: string, scope: "project" | "global") => ({
      serverId: label,
      label,
      scope,
      projectId: scope === "project" ? "p1" : null,
      status: "ready" as const,
      latencyMs: null,
      failureCount: 0,
      lastError: null,
      ts: 0,
    });
    const recordingSink = (emitted: string[]) => ({
      to: (rooms: string[]) => ({
        emit: (_ev: "mcp:status", e: { label: string }) => {
          emitted.push(`${e.label}@${rooms.join(",")}`);
        },
      }),
    });

    it("a never-resolving lookup times out to admins only and a later global event is still delivered", async () => {
      vi.useFakeTimers();
      const emitted: string[] = [];
      const errors: string[] = [];
      const { emit } = createMcpStatusEmitter(
        recordingSink(emitted),
        () => new Promise(() => {}),
        (err, e) => errors.push(`${e.label}:${(err as Error).message}`),
        { lookupTimeoutMs: 50 },
      );
      emit(event("p", "project"));
      emit(event("g", "global"));

      await vi.advanceTimersByTimeAsync(49);
      expect(emitted).toEqual([]);

      await vi.advanceTimersByTimeAsync(1);
      expect(emitted).toEqual([`p@${MCP_STATUS_ADMIN_ROOM}`, `g@${MCP_STATUS_ROOM}`]);
      expect(errors).toEqual(["p:project lookup timed out after 50ms"]);
    });

    it("defaults to MCP_STATUS_LOOKUP_TIMEOUT_MS", async () => {
      vi.useFakeTimers();
      const emitted: string[] = [];
      const { emit } = createMcpStatusEmitter(recordingSink(emitted), () => new Promise(() => {}));
      emit(event("p", "project"));
      emit(event("g", "global"));

      await vi.advanceTimersByTimeAsync(MCP_STATUS_LOOKUP_TIMEOUT_MS - 1);
      expect(emitted).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(emitted).toEqual([`p@${MCP_STATUS_ADMIN_ROOM}`, `g@${MCP_STATUS_ROOM}`]);
    });

    it("a lookup that settles in time routes normally and clears its timer", async () => {
      vi.useFakeTimers();
      const emitted: string[] = [];
      const errors: unknown[] = [];
      const { emit, drain } = createMcpStatusEmitter(
        recordingSink(emitted),
        async () => ({ workspaceId: "w" }),
        (err) => errors.push(err),
        { lookupTimeoutMs: 50 },
      );
      emit(event("p", "project"));
      await drain();
      expect(emitted).toEqual([`p@${mcpStatusWorkspaceRoom("w")},${MCP_STATUS_ADMIN_ROOM}`]);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(100);
      expect(errors).toEqual([]);
    });

    // PR #377 review — a lookup that throws synchronously used to leave the
    // timeout armed; it then rejected with no handler, which by default crashes
    // Node. It must be handled like any failed lookup and leave no timer behind.
    it("a lookup that throws synchronously leaves no timer and no unhandled rejection", async () => {
      vi.useFakeTimers();
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on("unhandledRejection", onUnhandled);
      try {
        const emitted: string[] = [];
        const errors: string[] = [];
        const { emit, drain } = createMcpStatusEmitter(
          recordingSink(emitted),
          () => {
            throw new Error("boom");
          },
          (err, e) => errors.push(`${e.label}:${(err as Error).message}`),
          { lookupTimeoutMs: 50 },
        );
        emit(event("p", "project"));
        await drain();
        expect(emitted).toEqual([`p@${MCP_STATUS_ADMIN_ROOM}`]);
        expect(errors).toEqual(["p:boom"]);
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(100);
        vi.useRealTimers();
        await new Promise((r) => setImmediate(r));
        expect(unhandled).toEqual([]);
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    });

    it("ignores a non-positive or non-finite lookupTimeoutMs and uses the default", async () => {
      for (const bad of [0, -1, Number.NaN]) {
        vi.useFakeTimers();
        const emitted: string[] = [];
        const { emit } = createMcpStatusEmitter(
          recordingSink(emitted),
          () => new Promise(() => {}),
          undefined,
          {
            lookupTimeoutMs: bad,
          },
        );
        emit(event("p", "project"));
        await vi.advanceTimersByTimeAsync(10);
        expect(emitted).toEqual([]);
        await vi.advanceTimersByTimeAsync(MCP_STATUS_LOOKUP_TIMEOUT_MS);
        expect(emitted).toEqual([`p@${MCP_STATUS_ADMIN_ROOM}`]);
        vi.useRealTimers();
      }
    });
  });
});

describe("#562 mcp:status — workspace rooms come from live memberships, not the token claim", () => {
  it("a stale claim to a deleted workspace or a workspace the user left joins no room", async () => {
    // Token issued while u-stale was in ws-deleted (since soft-deleted) and in
    // ws2 (since removed from: no membership row).
    const stale = await subscribe("u-stale", "coordinator", ["ws-deleted", "ws2"]);
    const admin = await subscribe("u-admin562", "admin");
    await vi.waitFor(() => expect(roomHas(MCP_STATUS_ADMIN_ROOM, admin.sid)).toBe(true));

    expect(roomHas(mcpStatusWorkspaceRoom("ws-deleted"), stale.sid)).toBe(false);
    expect(roomHas(mcpStatusWorkspaceRoom("ws2"), stale.sid)).toBe(false);

    await mcp.lifecycle.start(
      config({ id: "pd", label: "deleted-ws-srv", scope: "project", projectId: "p-wsdel" }),
    );
    await mcp.lifecycle.start(
      config({ id: "p2", label: "left-ws-srv", scope: "project", projectId: "p-ws2" }),
    );
    await mcp.lifecycle.start(config({ id: "z562", label: "sentinel-562" }));
    await vi.waitFor(() => {
      for (const s of [stale, admin]) expect(s.labels).toContain("sentinel-562");
    });

    expect(stale.labels).not.toContain("deleted-ws-srv");
    expect(stale.labels).not.toContain("left-ws-srv");
    expect(admin.labels).toContain("deleted-ws-srv");
    expect(admin.labels).toContain("left-ws-srv");
  });

  it("a live membership the token predates still joins its workspace room", async () => {
    const late = await subscribe("u-late", "coordinator", []);
    await vi.waitFor(() => expect(roomHas(mcpStatusWorkspaceRoom("ws1"), late.sid)).toBe(true));
  });

  it("a failed membership lookup joins no workspace room (fail closed)", async () => {
    const down = await subscribe("u-db-down", "coordinator", ["ws1"]);
    await vi.waitFor(() => expect(roomHas(mcpStatusOwnerRoom("u-db-down"), down.sid)).toBe(true));
    expect(roomHas(mcpStatusWorkspaceRoom("ws1"), down.sid)).toBe(false);
  });

  it("an unsubscribe that lands while the membership lookup is pending wins", async () => {
    // A fresh gate per attempt, so a retry re-runs the race rather than
    // meeting a lookup that has already resolved.
    let release!: () => void;
    const gate = { promise: new Promise<void>((r) => (release = r)), release: () => release() };
    slowMembership.gate = gate;
    const findMany = vi.mocked(prisma.workspaceMember.findMany);
    const slowLookups = () =>
      findMany.mock.calls.filter(([args]) => args?.where?.userId === "u-slow").length;
    const slowLookupsBefore = slowLookups();

    const { accessToken } = issueTokens({
      userId: "u-slow",
      username: "u-slow",
      role: "coordinator",
      permissions: [],
      workspaces: [],
    });
    const socket = ioClient(`http://127.0.0.1:${port}`, {
      auth: { token: accessToken },
      transports: ["websocket"],
      reconnection: false,
      timeout: 2000,
    });
    open.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.on("auth:ok", () => resolve());
      socket.on("connect_error", reject);
    });
    const sid = socket.id!;
    // A test-only acked event on this socket's SERVER side. Socket.IO delivers
    // one connection's packets in order (never across connections), so its ack
    // proves the server has run the subscribe:mcp and unsubscribe:mcp handlers
    // sent before it on the same socket.
    const serverSocket = io.sockets.sockets.get(sid);
    expect(serverSocket).toBeDefined();
    (serverSocket as unknown as BarrierSocket).on("test:barrier", (ack) => ack());

    socket.emit("subscribe:mcp");
    socket.emit("unsubscribe:mcp");
    await socket.timeout(2000).emitWithAck("test:barrier");

    // The subscribe's lookup is in flight and held open: the race is set up.
    expect(slowLookups()).toBe(slowLookupsBefore + 1);
    expect(roomHas(MCP_STATUS_ROOM, sid)).toBe(false);

    gate.release();
    // From the lookup resolving to a join is microtasks only (the in-memory
    // adapter joins synchronously), so after one macrotask turn a stale
    // subscribe would already have joined.
    await new Promise<void>((r) => setImmediate(r));
    expect(roomHas(MCP_STATUS_ROOM, sid)).toBe(false);
    expect(roomHas(mcpStatusWorkspaceRoom("ws1"), sid)).toBe(false);
  });

  it("unsubscribe:mcp leaves the workspace rooms it joined", async () => {
    const member = await subscribe("u-member", "coordinator", ["ws1"]);
    await vi.waitFor(() => expect(roomHas(mcpStatusWorkspaceRoom("ws1"), member.sid)).toBe(true));
    member.socket.emit("unsubscribe:mcp");
    await vi.waitFor(() => {
      expect(roomHas(mcpStatusWorkspaceRoom("ws1"), member.sid)).toBe(false);
      expect(roomHas(MCP_STATUS_ROOM, member.sid)).toBe(false);
    });
  });
});
