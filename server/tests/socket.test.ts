/**
 * Socket.IO server: handshake auth + room subscription smoke test.
 */
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";

/**
 * #255 — `subscribe:project` now authorizes the user against their accessible
 * projects via `actorCanAccessProject` → `prisma.project.findMany`. The mock
 * grants the developer `u1` access to project `p1` only (they "created" it), so
 * cross-project isolation can be asserted: `p1` joins, `p-other` is rejected.
 * Admins bypass the DB check entirely.
 */
vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    $queryRawUnsafe: vi.fn(async () => 1),
    user: { upsert: vi.fn() },
    userRole: { findFirst: vi.fn(async () => null) },
    auditLog: { create: vi.fn(async () => ({})) },
    project: {
      // Non-admin path: returns the projects whose `createdById` matches the
      // actor. Honour the `where.createdById` filter so each user only "owns"
      // their own projects.
      findMany: vi.fn(async (args?: { where?: { createdById?: string } }) => {
        const createdById = args?.where?.createdById;
        if (createdById === "u1") return [{ id: "p1", name: "P1" }];
        return [];
      }),
    },
  },
}));

import { createSocketServer, type MetisIOServer } from "../src/lib/socket/server.js";
import { issueTokens } from "../src/lib/auth/jwt.js";

let httpServer: http.Server;
let io: MetisIOServer;
let port: number;

beforeAll(async () => {
  httpServer = http.createServer();
  io = createSocketServer(httpServer);
  await new Promise<void>((resolve) => {
    httpServer.listen(0, () => {
      const addr = httpServer.address();
      if (addr && typeof addr === "object") port = addr.port;
      resolve();
    });
  });
});

afterAll(async () => {
  await io.close();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

function makeClient(opts: {
  token?: string;
}): Promise<{ socket: ClientSocket; ok: boolean; err?: string }> {
  return new Promise((resolve) => {
    const socket = ioClient(`http://127.0.0.1:${port}`, {
      auth: opts.token ? { token: opts.token } : {},
      transports: ["websocket"],
      reconnection: false,
      timeout: 1500,
    });
    socket.on("connect", () => resolve({ socket, ok: true }));
    socket.on("connect_error", (err) => resolve({ socket, ok: false, err: err.message }));
  });
}

describe("Socket.IO server", () => {
  it("rejects connections without a JWT", async () => {
    const { ok, err, socket } = await makeClient({});
    expect(ok).toBe(false);
    expect(err).toBe("UNAUTHORIZED");
    socket.close();
  });

  it("rejects connections with a malformed JWT", async () => {
    const { ok, err, socket } = await makeClient({ token: "garbage" });
    expect(ok).toBe(false);
    expect(err).toBe("TOKEN_INVALID");
    socket.close();
  });

  it("accepts a valid JWT, emits auth:ok, and supports room subscriptions", async () => {
    const { accessToken } = issueTokens({
      userId: "u1",
      username: "alice",
      role: "developer",
      permissions: ["analysis.read"],
    });
    const socket = ioClient(`http://127.0.0.1:${port}`, {
      auth: { token: accessToken },
      transports: ["websocket"],
      reconnection: false,
      timeout: 1500,
    });
    const authOk = await new Promise<{ userId: string; username: string }>((resolve, reject) => {
      socket.on("auth:ok", resolve);
      socket.on("connect_error", (err) => reject(err));
    });
    expect(authOk.userId).toBe("u1");

    socket.emit("subscribe:project", { projectId: "p1" });
    socket.emit("subscribe:analysis", { analysisId: "a1" });
    socket.emit("subscribe:session", { sessionId: "s1" });
    // Give the server a tick to process room joins.
    await new Promise((r) => setTimeout(r, 50));

    const projectRoomSize = io.sockets.adapter.rooms.get("project:p1")?.size ?? 0;
    const analysisRoomSize = io.sockets.adapter.rooms.get("analysis:a1")?.size ?? 0;
    const sessionRoomSize = io.sockets.adapter.rooms.get("session:s1")?.size ?? 0;
    expect(projectRoomSize).toBe(1);
    expect(analysisRoomSize).toBe(1);
    expect(sessionRoomSize).toBe(1);

    socket.emit("unsubscribe:project", { projectId: "p1" });
    socket.emit("unsubscribe:analysis", { analysisId: "a1" });
    socket.emit("unsubscribe:session", { sessionId: "s1" });
    await new Promise((r) => setTimeout(r, 50));
    expect(io.sockets.adapter.rooms.get("project:p1")).toBeUndefined();

    socket.close();
  });

  // SEC-5: subscribe:mcp must be admin-only.
  it("rejects subscribe:mcp from non-admin and emits auth:error", async () => {
    const { accessToken } = issueTokens({
      userId: "u-dev",
      username: "dev",
      role: "developer",
      permissions: ["analysis.read"],
    });
    const socket = ioClient(`http://127.0.0.1:${port}`, {
      auth: { token: accessToken },
      transports: ["websocket"],
      reconnection: false,
      timeout: 1500,
    });
    await new Promise<void>((resolve, reject) => {
      socket.on("auth:ok", () => resolve());
      socket.on("connect_error", (err) => reject(err));
    });
    const errPromise = new Promise<{ message: string }>((resolve) => {
      socket.on("auth:error", resolve);
    });
    socket.emit("subscribe:mcp");
    const err = await errPromise;
    expect(err.message).toMatch(/FORBIDDEN/);
    await new Promise((r) => setTimeout(r, 50));
    expect(io.sockets.adapter.rooms.get("mcp:status")).toBeUndefined();
    socket.close();
  });

  it("allows subscribe:mcp for admin role", async () => {
    const { accessToken } = issueTokens({
      userId: "u-admin",
      username: "admin",
      role: "admin",
      permissions: ["mcp.manage"],
    });
    const socket = ioClient(`http://127.0.0.1:${port}`, {
      auth: { token: accessToken },
      transports: ["websocket"],
      reconnection: false,
      timeout: 1500,
    });
    await new Promise<void>((resolve, reject) => {
      socket.on("auth:ok", () => resolve());
      socket.on("connect_error", (err) => reject(err));
    });
    socket.emit("subscribe:mcp");
    await new Promise((r) => setTimeout(r, 50));
    expect(io.sockets.adapter.rooms.get("mcp:status")?.size ?? 0).toBe(1);
    socket.close();
  });

  // #255 — cross-project isolation: a non-member must be rejected from another
  // project's room and receive NO events broadcast to it.
  it("rejects subscribe:project for a project the user cannot access", async () => {
    const { accessToken } = issueTokens({
      userId: "u1",
      username: "alice",
      role: "developer",
      permissions: ["analysis.read"],
    });
    const socket = ioClient(`http://127.0.0.1:${port}`, {
      auth: { token: accessToken },
      transports: ["websocket"],
      reconnection: false,
      timeout: 1500,
    });
    await new Promise<void>((resolve, reject) => {
      socket.on("auth:ok", () => resolve());
      socket.on("connect_error", (err) => reject(err));
    });
    const errPromise = new Promise<{ message: string }>((resolve) => {
      socket.on("auth:error", resolve);
    });
    // u1 owns only p1 (per the prisma mock); p-other belongs to another team.
    socket.emit("subscribe:project", { projectId: "p-other" });
    const err = await errPromise;
    expect(err.message).toMatch(/FORBIDDEN/);

    await new Promise((r) => setTimeout(r, 50));
    // The socket never joined the room → it receives no broadcast to it.
    expect(io.sockets.adapter.rooms.get("project:p-other")).toBeUndefined();

    // Prove no events leak: emit into the room and confirm nothing arrives.
    let leaked = false;
    socket.on("job:lifecycle", () => {
      leaked = true;
    });
    io.to("project:p-other").emit("job:lifecycle", {
      kind: "analysis",
      jobId: "j1",
      projectId: "p-other",
      status: "failed",
      error: "secret detail",
      ts: Date.now(),
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(leaked).toBe(false);
    socket.close();
  });

  it("allows subscribe:project for an admin regardless of ownership", async () => {
    const { accessToken } = issueTokens({
      userId: "u-admin",
      username: "admin",
      role: "admin",
      permissions: [],
    });
    const socket = ioClient(`http://127.0.0.1:${port}`, {
      auth: { token: accessToken },
      transports: ["websocket"],
      reconnection: false,
      timeout: 1500,
    });
    await new Promise<void>((resolve, reject) => {
      socket.on("auth:ok", () => resolve());
      socket.on("connect_error", (err) => reject(err));
    });
    socket.emit("subscribe:project", { projectId: "p-other" });
    await new Promise((r) => setTimeout(r, 50));
    expect(io.sockets.adapter.rooms.get("project:p-other")?.size ?? 0).toBe(1);
    socket.close();
  });
});
