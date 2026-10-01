/**
 * #658 review — socket.io runs `connection` listeners from `process.nextTick`
 * with no try/catch, so a synchronous throw from `attachHandlers` itself (not
 * from a handler it registers) was an uncaughtException. `createSocketServer`
 * registers `attachHandlers` through `onConnection`: the throw is logged, that
 * one socket is disconnected, and the process and every other socket live on.
 */
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";

const { error } = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("../src/lib/logger.js", () => ({
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error }),
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    $queryRawUnsafe: vi.fn(async () => 1),
    user: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        username: where.id,
        authRoleAuthority: null,
      })),
    },
    userRole: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => [{ source: "local", role: { key: "developer" } }]),
    },
    workspaceMember: { findMany: vi.fn(async () => []) },
    auditLog: { create: vi.fn(async () => ({})) },
  },
}));

// Force a synchronous throw part-way through `attachHandlers` for one user.
vi.mock("../src/lib/socket/discussion-rooms.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/socket/discussion-rooms.js")>();
  return {
    ...real,
    wireThreadRoomHandlers: (socket: Parameters<typeof real.wireThreadRoomHandlers>[0]) => {
      if (socket.data.user.userId === "u-boom") throw new Error("attach boom");
      real.wireThreadRoomHandlers(socket);
    },
  };
});

import { createSocketServer, type MetisIOServer } from "../src/lib/socket/server.js";
import { issueTokens } from "../src/lib/auth/jwt.js";

let httpServer: http.Server;
let io: MetisIOServer;
let port: number;

beforeAll(async () => {
  httpServer = http.createServer();
  io = createSocketServer(httpServer);
  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => {
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

function connect(userId: string): ClientSocket {
  const { accessToken } = issueTokens({
    userId,
    username: userId,
    role: "developer",
    permissions: [],
  });
  return ioClient(`http://127.0.0.1:${port}`, {
    auth: { token: accessToken },
    transports: ["websocket"],
    reconnection: false,
    timeout: 2000,
  });
}

describe("#658 a throw from attachHandlers", () => {
  it("drops that socket only, and leaves the process and other sockets alive", async () => {
    const crashes: unknown[] = [];
    const onCrash = (err: unknown): void => {
      crashes.push(err);
    };
    process.on("uncaughtException", onCrash);
    process.on("unhandledRejection", onCrash);
    const bystander = connect("u-ok");
    try {
      await new Promise<void>((resolve, reject) => {
        bystander.on("auth:ok", () => resolve());
        bystander.on("connect_error", reject);
      });

      const victim = connect("u-boom");
      let reason: string | undefined;
      victim.on("disconnect", (r) => {
        reason = r;
      });
      // Wait for either outcome, so an escaped throw fails fast and by name.
      await vi.waitFor(() => expect(reason ?? crashes[0]).toBeDefined(), { timeout: 3000 });
      // Give any escaped throw time to surface.
      await new Promise((r) => setTimeout(r, 100));
      expect(crashes).toEqual([]);
      expect(reason).toBe("io server disconnect");
      victim.close();

      expect(error).toHaveBeenCalledWith(
        "Socket connection setup failed; disconnecting the socket",
        expect.objectContaining({ error: "attach boom" }),
      );

      // The bystander is still connected and its handlers still run.
      expect(bystander.connected).toBe(true);
      bystander.emit("subscribe:bg-run", { runId: "r-658" });
      await vi.waitFor(() =>
        expect(io.sockets.adapter.rooms.get("run:r-658")?.has(bystander.id!)).toBe(true),
      );
      // A new socket after the failure is handled normally.
      const later = connect("u-later");
      await new Promise<void>((resolve, reject) => {
        later.on("auth:ok", () => resolve());
        later.on("connect_error", reject);
      });
      later.close();
    } finally {
      bystander.close();
      process.off("uncaughtException", onCrash);
      process.off("unhandledRejection", onCrash);
    }
  });
});
