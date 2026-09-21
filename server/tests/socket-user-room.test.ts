/**
 * Issue #416 — Socket user-room auto-join tests.
 *
 * Verifies that:
 *   - every socket auto-joins `user:{userId}` on connect (derived ONLY from the
 *     verified JWT, never from client input — OWASP A01).
 *   - the join fires on a fresh attachHandlers invocation (simulating reconnect).
 *   - there is NO `subscribe:user` handler that accepts a client-supplied id.
 *   - `comment:mention` and `sla:deadline_expired` are delivered to the joined room.
 *   - a user NEVER receives events addressed to another user's room.
 */
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";

// Minimal prisma mock to satisfy project-access checks.
vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    $queryRawUnsafe: vi.fn(async () => 1),
    user: { upsert: vi.fn() },
    userRole: { findFirst: vi.fn(async () => null) },
    auditLog: { create: vi.fn(async () => ({})) },
    project: {
      findMany: vi.fn(async (args?: { where?: { createdById?: string } }) => {
        const id = args?.where?.createdById;
        if (id === "u-alice") return [{ id: "p-alice", name: "Alice project" }];
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

function connect(
  userId: string,
  username = "testuser",
): Promise<{
  socket: ClientSocket;
  authOk: { userId: string; username: string };
}> {
  const { accessToken } = issueTokens({
    userId,
    username,
    role: "developer",
    permissions: [],
  });
  return new Promise((resolve, reject) => {
    const socket = ioClient(`http://127.0.0.1:${port}`, {
      auth: { token: accessToken },
      transports: ["websocket"],
      reconnection: false,
      timeout: 2000,
    });
    socket.on("auth:ok", (authOk) => resolve({ socket, authOk }));
    socket.on("connect_error", reject);
  });
}

describe("Issue #416 — socket user-room auto-join", () => {
  it("auto-joins user:{userId} room on connect (id from JWT only)", async () => {
    const { socket, authOk } = await connect("u-alice");
    expect(authOk.userId).toBe("u-alice");

    // Give the server a tick to process the room join.
    await new Promise((r) => setTimeout(r, 50));

    const roomSize = io.sockets.adapter.rooms.get("user:u-alice")?.size ?? 0;
    expect(roomSize).toBe(1);

    socket.close();
  });

  it("different users join different rooms — no cross-user leak", async () => {
    const [{ socket: s1 }, { socket: s2 }] = await Promise.all([
      connect("u-alice2"),
      connect("u-bob"),
    ]);

    await new Promise((r) => setTimeout(r, 50));

    expect(io.sockets.adapter.rooms.get("user:u-alice2")?.size ?? 0).toBe(1);
    expect(io.sockets.adapter.rooms.get("user:u-bob")?.size ?? 0).toBe(1);

    // u-alice's room does NOT contain u-bob's socket and vice-versa.
    const aliceRoom = io.sockets.adapter.rooms.get("user:u-alice2");
    expect(aliceRoom).toBeDefined();
    // Collect socket ids in alice's room.
    const aliceSockets = [...(aliceRoom ?? [])];
    expect(aliceSockets).not.toContain(s2.id);

    s1.close();
    s2.close();
  });

  it("comment:mention is delivered to the mentioned user's room", async () => {
    const { socket, authOk } = await connect("u-carol");
    expect(authOk.userId).toBe("u-carol");

    await new Promise((r) => setTimeout(r, 50));

    const mentionPayload = { commentId: "c-1", mentionedUserId: "u-carol", ts: Date.now() };

    const received = new Promise<typeof mentionPayload>((resolve) => {
      socket.on("comment:mention", resolve);
    });

    io.to("user:u-carol").emit("comment:mention", mentionPayload);

    const event = await received;
    expect(event.commentId).toBe("c-1");
    expect(event.mentionedUserId).toBe("u-carol");

    socket.close();
  });

  it("sla:deadline_expired is delivered to the user's room", async () => {
    const { socket } = await connect("u-dave");
    await new Promise((r) => setTimeout(r, 50));

    const slaPayload = {
      assignmentId: "assign-1",
      requirementId: "req-1",
      requirementTitle: "My Req",
      slaDeadline: new Date().toISOString(),
      ts: Date.now(),
    };

    const received = new Promise<typeof slaPayload>((resolve) => {
      socket.on("sla:deadline_expired", resolve);
    });

    io.to("user:u-dave").emit("sla:deadline_expired", slaPayload);

    const event = await received;
    expect(event.assignmentId).toBe("assign-1");
    expect(event.requirementTitle).toBe("My Req");

    socket.close();
  });

  it("emitting to user:X does NOT reach user:Y", async () => {
    const [{ socket: s1 }, { socket: s2 }] = await Promise.all([
      connect("u-eve"),
      connect("u-frank"),
    ]);

    await new Promise((r) => setTimeout(r, 50));

    const frankReceived: unknown[] = [];
    s2.on("comment:mention", (e) => frankReceived.push(e));

    // Emit only to u-eve.
    io.to("user:u-eve").emit("comment:mention", {
      commentId: "c-secret",
      mentionedUserId: "u-eve",
      ts: Date.now(),
    });

    await new Promise((r) => setTimeout(r, 80));

    // Frank (u-frank) must not have received u-eve's mention.
    expect(frankReceived).toHaveLength(0);

    s1.close();
    s2.close();
  });

  it("there is NO subscribe:user handler that accepts a client-supplied id", async () => {
    // OWASP A01 guard: if a rogue client sends subscribe:user with an arbitrary
    // id, the server must NOT join them to that room (there is no such handler).
    const { socket, authOk } = await connect("u-grace");
    expect(authOk.userId).toBe("u-grace");
    await new Promise((r) => setTimeout(r, 50));

    // Attempt to join another user's room by abusing a hypothetical subscribe:user.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (socket as any).emit("subscribe:user", { userId: "u-victim" });
    await new Promise((r) => setTimeout(r, 80));

    // The victim's room should remain empty (or not include grace's socket).
    const victimRoom = io.sockets.adapter.rooms.get("user:u-victim");
    if (victimRoom) {
      // grace's socket must not be in u-victim's room.
      const victimSockets = [...victimRoom];
      expect(victimSockets).not.toContain(socket.id);
    } else {
      // Room doesn't exist at all — that's fine too.
      expect(victimRoom).toBeUndefined();
    }

    socket.close();
  });

  it("auto-join fires on reconnect (fresh attachHandlers invocation)", async () => {
    // Each new connection triggers attachHandlers → socket.join is called again.
    // We verify by connecting twice with the same userId and checking that both
    // sockets are in the room.
    const { socket: s1 } = await connect("u-henry");
    await new Promise((r) => setTimeout(r, 50));
    const sizeAfterFirst = io.sockets.adapter.rooms.get("user:u-henry")?.size ?? 0;
    expect(sizeAfterFirst).toBe(1);

    // Simulate reconnect: open a second socket (as would happen on reconnect).
    const { socket: s2 } = await connect("u-henry");
    await new Promise((r) => setTimeout(r, 50));
    const sizeAfterSecond = io.sockets.adapter.rooms.get("user:u-henry")?.size ?? 0;
    expect(sizeAfterSecond).toBe(2);

    s1.close();
    s2.close();
  });
});
