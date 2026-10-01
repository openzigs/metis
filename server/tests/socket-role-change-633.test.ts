/**
 * #633 — a role change reaches the user's already-connected sockets.
 *
 * #617 made the handshake read the durable role, but a socket that was already
 * connected kept its connect-time role: a demoted admin stayed in
 * `mcp:status:admin` for the life of the connection. A role change now closes
 * the user's socket transports, so the client's own reconnect loop re-handshakes
 * and every room gate runs again against the new role.
 *
 * Real Socket.IO server and clients (with reconnection on, as the UI runs it),
 * the real `bootstrapMCP` emit path and the real SCIM router (supertest), with
 * Prisma mocked over an in-memory user and role-assignment table.
 */
import http from "node:http";
import express, { type Express } from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";

interface UserRow {
  id: string;
  username: string;
  status: string;
  deletedAt: Date | null;
  authRoleAuthority: string | null;
}
interface Assignment {
  userId: string;
  roleId: string;
  source: string;
}

const ROLE_KEYS: Record<string, string> = { "role-admin": "admin", "role-reader": "reader" };

// Replaced in each test body (server vitest has `retry: 2`).
const db = vi.hoisted(() => ({
  users: new Map<string, UserRow>(),
  assignments: [] as Assignment[],
}));

vi.mock("../src/lib/prisma.js", () => {
  const matches = (a: Assignment, where: Record<string, unknown>) =>
    (where.userId === undefined || a.userId === where.userId) &&
    (where.roleId === undefined || a.roleId === where.roleId) &&
    (where.source === undefined ||
      (typeof where.source === "string"
        ? a.source === where.source
        : (where.source as { in: string[] }).in.includes(a.source)));
  const client = {
    user: {
      findFirst: vi.fn(
        async ({ where }: { where: { id: string; deletedAt?: null; status?: string } }) => {
          const row = db.users.get(where.id);
          if (!row) return null;
          if (where.deletedAt === null && row.deletedAt !== null) return null;
          if (where.status !== undefined && row.status !== where.status) return null;
          return { ...row };
        },
      ),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<UserRow> }) => {
        const row = db.users.get(where.id)!;
        Object.assign(row, data);
        return { ...row };
      }),
    },
    userRole: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        db.assignments
          .filter((a) => matches(a, where))
          .map((a) => ({ ...a, role: { key: ROLE_KEYS[a.roleId] } })),
      ),
      findUnique: vi.fn(
        async ({ where }: { where: { userId_roleId: { userId: string; roleId: string } } }) =>
          db.assignments.find(
            (a) =>
              a.userId === where.userId_roleId.userId && a.roleId === where.userId_roleId.roleId,
          ) ?? null,
      ),
      deleteMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const before = db.assignments.length;
        db.assignments = db.assignments.filter((a) => !matches(a, where));
        return { count: before - db.assignments.length };
      }),
      upsert: vi.fn(),
    },
    role: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        ROLE_KEYS[where.id]
          ? {
              id: where.id,
              key: ROLE_KEYS[where.id],
              name: ROLE_KEYS[where.id],
              createdAt: new Date(),
              updatedAt: new Date(),
              users: [],
            }
          : null,
      ),
    },
    workspaceMember: { findMany: vi.fn(async () => []) },
    project: { findUnique: vi.fn(async () => null) },
    $transaction: vi.fn(async (work: (tx: unknown) => unknown) => work(client)),
  };
  return { prisma: client };
});

vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

import { createSocketServer, type MetisIOServer } from "../src/lib/socket/server.js";
import { registerSocketServer } from "../src/lib/socket/registry.js";
import { issueTokens } from "../src/lib/auth/jwt.js";
import { bootstrapMCP, type MCPBootstrap } from "../src/lib/mcp/index.js";
import type { MCPServerConfig } from "../src/lib/mcp/types.js";
import { MCP_STATUS_ADMIN_ROOM } from "../src/lib/mcp/status-rooms.js";
import { __resetScimTokens, addScimToken, scimRouter } from "../src/routes/scim.js";

const SCIM_AUTH = "Bearer scim-633-token";

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
  app = express();
  app.use(express.json());
  app.use("/scim/v2", scimRouter());
});

afterAll(async () => {
  registerSocketServer(null as never);
  __resetScimTokens();
  await mcp.shutdown();
  await io.close();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

const open: ClientSocket[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
});

const inAdminRoom = (sid: string) =>
  io.sockets.adapter.rooms.get(MCP_STATUS_ADMIN_ROOM)?.has(sid) ?? false;

interface Admin {
  socket: ClientSocket;
  labels: string[];
  /** Every sid this client has held, in order — a reconnect appends one. */
  sids: string[];
  disconnectReasons: string[];
  authErrors: string[];
}

function seed(admins: string[]): void {
  __resetScimTokens();
  addScimToken("scim-633-token");
  db.users = new Map(
    admins.map((id) => [
      id,
      { id, username: id, status: "active", deletedAt: null, authRoleAuthority: "scim" },
    ]),
  );
  db.assignments = admins.map((userId) => ({ userId, roleId: "role-admin", source: "scim" }));
}

/**
 * Connect as the UI does — reconnection on — and, like the UI's MCP views,
 * (re)subscribe to MCP status on every connect.
 */
async function connectAdmin(userId: string): Promise<Admin> {
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
  const admin: Admin = { socket, labels: [], sids: [], disconnectReasons: [], authErrors: [] };
  socket.on("connect", () => {
    admin.sids.push(socket.id!);
    socket.emit("subscribe:mcp");
  });
  socket.on("disconnect", (reason) => admin.disconnectReasons.push(reason));
  socket.on("auth:error", (e: { message: string }) => admin.authErrors.push(e.message));
  socket.on("mcp:status", (e: { label: string }) => admin.labels.push(e.label));
  await vi.waitFor(() => expect(admin.sids.length).toBe(1));
  await vi.waitFor(() => expect(inAdminRoom(admin.sids[0])).toBe(true));
  return admin;
}

/** A user-scope server with no owner on record: its events reach admins only. */
function adminOnlyServer(label: string): MCPServerConfig {
  return {
    id: label,
    scope: "user",
    projectId: null,
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

const removeFromGroup = (userId: string, roleId: string) =>
  request(app)
    .patch(`/scim/v2/Groups/${roleId}`)
    .set("Authorization", SCIM_AUTH)
    .send({ Operations: [{ op: "remove", path: "members", value: [{ value: userId }] }] });

describe("#633 a role change re-handshakes the user's open sockets", () => {
  it("a demoted admin reconnects as a reader and stops receiving admin-room events", async () => {
    seed(["u-demoted", "u-admin"]);
    const demoted = await connectAdmin("u-demoted");
    const demotedTab2 = await connectAdmin("u-demoted");
    const kept = await connectAdmin("u-admin");

    await mcp.lifecycle.start(adminOnlyServer("before"));
    await vi.waitFor(() => {
      for (const a of [demoted, demotedTab2, kept]) expect(a.labels).toContain("before");
    });

    const res = await removeFromGroup("u-demoted", "role-admin");
    expect(res.status).toBe(200);

    // Each tab's transport was closed, so the client retried on its own and
    // re-handshook — getting the durable reader role, not the token's admin.
    await vi.waitFor(() => {
      for (const a of [demoted, demotedTab2]) {
        expect(a.disconnectReasons).toEqual(["transport close"]);
        expect(a.sids).toHaveLength(2);
        expect(a.socket.connected).toBe(true);
        expect(a.authErrors.some((m) => m.includes("mcp.manage"))).toBe(true);
      }
    });
    for (const a of [demoted, demotedTab2]) {
      expect(io.sockets.sockets.has(a.sids[0])).toBe(false);
      expect(inAdminRoom(a.sids[1])).toBe(false);
      expect(io.sockets.sockets.get(a.sids[1])?.data.user.role).toBe("reader");
    }

    await mcp.lifecycle.start(adminOnlyServer("after"));
    await vi.waitFor(() => expect(kept.labels).toContain("after"));
    // The kept admin's connection was never touched.
    expect(kept.disconnectReasons).toEqual([]);
    expect(kept.sids).toHaveLength(1);
    for (const a of [demoted, demotedTab2]) expect(a.labels).not.toContain("after");
  });

  it("a group change that alters no assignment leaves the user's sockets alone", async () => {
    seed(["u-steady"]);
    const steady = await connectAdmin("u-steady");
    // No reader membership exists, so removing it changes nothing.
    const res = await removeFromGroup("u-steady", "role-reader");
    expect(res.status).toBe(200);
    await mcp.lifecycle.start(adminOnlyServer("steady"));
    await vi.waitFor(() => expect(steady.labels).toContain("steady"));
    expect(steady.disconnectReasons).toEqual([]);
    expect(steady.sids).toHaveLength(1);
  });
});
