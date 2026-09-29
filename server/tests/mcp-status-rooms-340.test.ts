/**
 * #340 — a `scope: "user"` MCP server's `mcp:status` events reach ONLY its
 * owner and system admins.
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

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    $queryRawUnsafe: vi.fn(async () => 1),
    user: { upsert: vi.fn() },
    userRole: { findFirst: vi.fn(async () => null) },
    auditLog: { create: vi.fn(async () => ({})) },
    project: { findMany: vi.fn(async () => []) },
  },
}));

import { createSocketServer, type MetisIOServer } from "../src/lib/socket/server.js";
import { issueTokens } from "../src/lib/auth/jwt.js";
import { bootstrapMCP, type MCPBootstrap } from "../src/lib/mcp/index.js";
import type { MCPServerConfig } from "../src/lib/mcp/types.js";
import {
  MCP_STATUS_ADMIN_ROOM,
  MCP_STATUS_ROOM,
  mcpStatusOwnerRoom,
  mcpStatusRooms,
  mcpStatusRoomsFor,
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

async function subscribe(userId: string, role: "admin" | "coordinator"): Promise<Subscriber> {
  const { accessToken } = issueTokens({ userId, username: userId, role, permissions: [] });
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
      config({ id: "p", label: "project-srv", scope: "project", projectId: "p1" }),
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

    // Global and project events are unchanged: every mcp.manage subscriber.
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
    expect(mcpStatusRooms({ scope: "global" }, null)).toEqual([MCP_STATUS_ROOM]);
    expect(mcpStatusRooms({ scope: "project" }, null)).toEqual([MCP_STATUS_ROOM]);
    expect(mcpStatusRooms({ scope: "user" }, "u1")).toEqual([
      mcpStatusOwnerRoom("u1"),
      MCP_STATUS_ADMIN_ROOM,
    ]);
    expect(mcpStatusRooms({ scope: "user" }, null)).toEqual([MCP_STATUS_ADMIN_ROOM]);
  });

  it("puts only admins in the admin room", () => {
    expect(mcpStatusRoomsFor({ userId: "u1", role: "coordinator" })).toEqual([
      MCP_STATUS_ROOM,
      mcpStatusOwnerRoom("u1"),
    ]);
    expect(mcpStatusRoomsFor({ userId: "a", role: "admin" })).toContain(MCP_STATUS_ADMIN_ROOM);
  });
});
