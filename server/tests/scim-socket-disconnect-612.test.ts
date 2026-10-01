/**
 * #612 — a SCIM deprovision (DELETE, or PATCH `active: false`) disconnects every
 * open socket of that user, and `readLiveWorkspaceIds` no longer counts the
 * memberships of a soft-deleted or disabled user, so a socket that reconnects
 * with a still-unexpired access token joins no workspace room.
 *
 * Before this, deprovision revoked refresh tokens only: the user's open sockets
 * kept every room they had joined (MCP workspace status rooms included), and a
 * re-subscribe re-joined them, because the `WorkspaceMember` rows survive the
 * soft delete.
 *
 * Real Socket.IO server and clients, the real `bootstrapMCP` emit path and the
 * real SCIM router (supertest), with Prisma mocked over an in-memory user and
 * membership table.
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
}

// Replaced in each test body (server vitest has `retry: 2`; a retry must start
// from the fixture again, not from what the failed attempt's DELETE left).
const db = vi.hoisted(() => ({
  users: new Map<string, UserRow>(),
  /** `${workspaceId}:${userId}` → membership. */
  members: new Map<string, { workspaceId: string; userId: string }>(),
}));

function matchesUser(row: UserRow, where: { deletedAt?: null; status?: string } = {}): boolean {
  if (where.deletedAt === null && row.deletedAt !== null) return false;
  if (where.status !== undefined && row.status !== where.status) return false;
  return true;
}

vi.mock("../src/lib/prisma.js", () => {
  const user = {
    findFirst: vi.fn(async ({ where }: { where: { id: string; deletedAt?: null } }) => {
      const row = db.users.get(where.id);
      return row && matchesUser(row, where) ? { ...row } : null;
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<UserRow> }) => {
      const row = db.users.get(where.id)!;
      Object.assign(row, data);
      return { ...row, createdAt: new Date(), updatedAt: new Date(), email: null };
    }),
  };
  const userRole = {
    deleteMany: vi.fn(async () => ({ count: 0 })),
    // #617 — the handshake resolves the durable role: every user here is a
    // coordinator, matching the token `subscribe` issues.
    findMany: vi.fn(async () => [{ source: "local", role: { key: "coordinator" } }]),
  };
  const client = {
    user,
    userRole,
    workspaceMember: {
      // `readLiveWorkspaceIds` — honours the user filter under test.
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: { userId: string; user?: { deletedAt?: null; status?: string } };
        }) =>
          [...db.members.values()]
            .filter((m) => m.userId === where.userId)
            .filter((m) => {
              const row = db.users.get(m.userId);
              return !where.user || (row !== undefined && matchesUser(row, where.user));
            })
            .map((m) => ({ workspaceId: m.workspaceId })),
      ),
    },
    project: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id.startsWith("p-") ? { workspaceId: where.id.slice(2) } : null,
      ),
    },
    $transaction: vi.fn(async (work: (tx: unknown) => unknown) => work(client)),
  };
  return { prisma: client };
});

vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));
// Session revocation is covered by tests/scim.test.ts; its store is not what is
// under test here.
vi.mock("../src/lib/auth/jwt.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/auth/jwt.js")>()),
  revokeAllUserSessions: vi.fn(async () => {}),
}));

import { createSocketServer, type MetisIOServer } from "../src/lib/socket/server.js";
import { registerSocketServer } from "../src/lib/socket/registry.js";
import { issueTokens } from "../src/lib/auth/jwt.js";
import { bootstrapMCP, type MCPBootstrap } from "../src/lib/mcp/index.js";
import type { MCPServerConfig } from "../src/lib/mcp/types.js";
import { MCP_STATUS_ROOM, mcpStatusWorkspaceRoom } from "../src/lib/mcp/status-rooms.js";
import { __resetScimTokens, addScimToken, scimRouter } from "../src/routes/scim.js";

const SCIM_AUTH = "Bearer scim-612-token";

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

const roomHas = (room: string, sid: string) =>
  io.sockets.adapter.rooms.get(room)?.has(sid) ?? false;

interface Subscriber {
  socket: ClientSocket;
  labels: string[];
  sid: string;
  disconnectReason: string | null;
}

function seed(users: string[], memberships: Array<[workspaceId: string, userId: string]>): void {
  __resetScimTokens();
  addScimToken("scim-612-token");
  db.users = new Map(
    users.map((id) => [id, { id, username: id, status: "active", deletedAt: null }]),
  );
  db.members = new Map(
    memberships.map(([workspaceId, userId]) => [
      `${workspaceId}:${userId}`,
      { workspaceId, userId },
    ]),
  );
}

async function subscribe(userId: string): Promise<Subscriber> {
  const { accessToken } = issueTokens({
    userId,
    username: userId,
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
  const sub: Subscriber = { socket, labels: [], sid, disconnectReason: null };
  socket.on("mcp:status", (e: { label: string }) => sub.labels.push(e.label));
  socket.on("disconnect", (reason) => {
    sub.disconnectReason = reason;
  });
  socket.emit("subscribe:mcp");
  await vi.waitFor(() => expect(roomHas(MCP_STATUS_ROOM, sid)).toBe(true));
  return sub;
}

function server(workspaceId: string | null, label: string): MCPServerConfig {
  return {
    id: label,
    scope: workspaceId ? "project" : "global",
    projectId: workspaceId ? `p-${workspaceId}` : null,
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

/** Emit one workspace event, then a global sentinel every listener must see. */
async function emitAndSettle(listeners: Subscriber[], workspaceId: string, tag: string) {
  await mcp.lifecycle.start(server(workspaceId, `${workspaceId}-${tag}`));
  const sentinel = `sentinel-${tag}`;
  await mcp.lifecycle.start(server(null, sentinel));
  await vi.waitFor(() => {
    for (const s of listeners) expect(s.labels).toContain(sentinel);
  });
}

/** Both deprovision paths: DELETE soft-deletes, PATCH active=false disables. */
const DEPROVISION = [
  ["DELETE", (id: string) => request(app).delete(`/scim/v2/Users/${id}`), 204],
  [
    "PATCH active=false",
    (id: string) =>
      request(app)
        .patch(`/scim/v2/Users/${id}`)
        .send({ Operations: [{ op: "replace", path: "active", value: false }] }),
    200,
  ],
] as const;

describe("#612 SCIM deprovision disconnects the user's sockets", () => {
  it.each(DEPROVISION)(
    "%s disconnects every socket of that user; another member keeps its events",
    async (_name, deprovision, status) => {
      seed(
        ["u-gone", "u-kept"],
        [
          ["ws-612", "u-gone"],
          ["ws-612", "u-kept"],
        ],
      );
      const gone = await subscribe("u-gone");
      const goneTab2 = await subscribe("u-gone");
      const kept = await subscribe("u-kept");
      await vi.waitFor(() => {
        for (const s of [gone, goneTab2, kept]) {
          expect(roomHas(mcpStatusWorkspaceRoom("ws-612"), s.sid)).toBe(true);
        }
      });

      const res = await deprovision("u-gone").set("Authorization", SCIM_AUTH);
      expect(res.status).toBe(status);

      await vi.waitFor(() => {
        for (const s of [gone, goneTab2]) {
          expect(s.socket.connected).toBe(false);
          expect(s.disconnectReason).toBe("io server disconnect");
        }
      });
      for (const s of [gone, goneTab2]) {
        expect(io.sockets.sockets.has(s.sid)).toBe(false);
        expect(roomHas(mcpStatusWorkspaceRoom("ws-612"), s.sid)).toBe(false);
      }

      await emitAndSettle([kept], "ws-612", "after");
      expect(kept.socket.connected).toBe(true);
      expect(kept.labels).toContain("ws-612-after");
      for (const s of [gone, goneTab2]) expect(s.labels).not.toContain("ws-612-after");
    },
  );

  it("a SCIM update that does not deactivate leaves the user's sockets connected", async () => {
    seed(["u-renamed"], [["ws-612b", "u-renamed"]]);
    const s = await subscribe("u-renamed");
    const res = await request(app)
      .patch("/scim/v2/Users/u-renamed")
      .set("Authorization", SCIM_AUTH)
      .send({ Operations: [{ op: "replace", path: "displayName", value: "Renamed" }] });
    expect(res.status).toBe(200);
    await emitAndSettle([s], "ws-612b", "rename");
    expect(s.socket.connected).toBe(true);
    expect(s.labels).toContain("ws-612b-rename");
  });

  // #617 — the handshake now re-reads the user, so the old access token is
  // refused outright instead of connecting and joining no workspace room.
  it.each(DEPROVISION)(
    "after %s, reconnecting with the old unexpired token is rejected at the handshake",
    async (_name, deprovision, status) => {
      seed(["u-back"], [["ws-612c", "u-back"]]);
      const before = await subscribe("u-back");
      await vi.waitFor(() =>
        expect(roomHas(mcpStatusWorkspaceRoom("ws-612c"), before.sid)).toBe(true),
      );
      const oldToken = (before.socket.auth as { token: string }).token;

      const res = await deprovision("u-back").set("Authorization", SCIM_AUTH);
      expect(res.status).toBe(status);
      await vi.waitFor(() => expect(before.socket.connected).toBe(false));

      // The WorkspaceMember row survives the deprovision and the access token
      // is still within its lifetime — only the live-user check refuses it.
      expect(db.members.has("ws-612c:u-back")).toBe(true);
      const again = ioClient(`http://127.0.0.1:${port}`, {
        auth: { token: oldToken },
        transports: ["websocket"],
        reconnection: false,
        timeout: 2000,
      });
      open.push(again);
      const outcome = await new Promise<string>((resolve) => {
        again.on("auth:ok", () => resolve("auth:ok"));
        again.on("connect_error", (err) => resolve(err.message));
      });
      expect(outcome).toBe("UNAUTHORIZED");
      expect(again.connected).toBe(false);
      // No server socket ever ran `attachHandlers` for the user.
      expect(io.sockets.adapter.rooms.get("user:u-back")).toBeUndefined();
    },
  );
});
