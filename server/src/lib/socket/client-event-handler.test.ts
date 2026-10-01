/**
 * #658 — a client-event handler that throws, or whose promise rejects, is
 * contained by `onClientEvent`: logged with the event name, the socket stays
 * connected, other sockets are unaffected, and the process sees neither an
 * `uncaughtException` nor an `unhandledRejection`.
 */
import http from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Server as SocketIOServer, type Socket } from "socket.io";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";

const { error } = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("../logger.js", () => ({
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error }),
}));

import { onClientEvent } from "./client-event-handler.js";

let httpServer: http.Server;
let io: SocketIOServer;
let port: number;

beforeAll(async () => {
  httpServer = http.createServer();
  io = new SocketIOServer(httpServer);
  io.on("connection", (socket: Socket) => {
    // A deliberately throwing handler and a deliberately rejecting one.
    onClientEvent(socket, "subscribe:connector", () => {
      throw new Error("sync boom");
    });
    onClientEvent(socket, "subscribe:task", async () => {
      await Promise.resolve();
      throw new Error("async boom");
    });
    // A rejection with a non-Error reason.
    onClientEvent(socket, "subscribe:publish", () => Promise.reject("string reason"));
    // A healthy handler: proves the socket still works afterwards, and that
    // arguments reach the handler unchanged.
    onClientEvent(socket, "subscribe:bg-run", (payload) => socket.join(`run:${payload.runId}`));
  });
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

afterEach(() => error.mockClear());

async function connect(): Promise<ClientSocket> {
  const socket = ioClient(`http://127.0.0.1:${port}`, {
    transports: ["websocket"],
    reconnection: false,
    timeout: 1500,
  });
  await new Promise<void>((resolve, reject) => {
    socket.on("connect", () => resolve());
    socket.on("connect_error", reject);
  });
  return socket;
}

function inRoom(room: string, socket: ClientSocket): boolean {
  return io.sockets.adapter.rooms.get(room)?.has(socket.id!) ?? false;
}

describe("#658 onClientEvent contains handler failures", () => {
  it("a throwing and a rejecting handler leave the process and every socket alive", async () => {
    const crashes: unknown[] = [];
    const onCrash = (err: unknown): void => {
      crashes.push(err);
    };
    process.on("uncaughtException", onCrash);
    process.on("unhandledRejection", onCrash);
    const attacker = await connect();
    const bystander = await connect();
    try {
      attacker.emit("subscribe:connector", { connectorId: "c1" });
      attacker.emit("subscribe:task", { taskId: "t1" });
      attacker.emit("subscribe:publish", { batchId: "b1" });
      await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(3));
      // Give any escaped throw or rejection time to surface.
      await new Promise((r) => setTimeout(r, 100));
      expect(crashes).toEqual([]);

      // Each failure is logged with its event name and the failing socket.
      const logged = error.mock.calls.map(([msg, meta]) => [
        msg,
        meta.event,
        meta.socketId,
        meta.error,
      ]);
      expect(logged).toEqual(
        expect.arrayContaining([
          ["Socket handler failed", "subscribe:connector", attacker.id, "sync boom"],
          ["Socket handler failed", "subscribe:task", attacker.id, "async boom"],
          ["Socket handler failed", "subscribe:publish", attacker.id, "string reason"],
        ]),
      );

      // Both sockets are still connected and still handled.
      expect(attacker.connected).toBe(true);
      expect(bystander.connected).toBe(true);
      attacker.emit("subscribe:bg-run", { runId: "r-attacker" });
      bystander.emit("subscribe:bg-run", { runId: "r-bystander" });
      await vi.waitFor(() => {
        expect(inRoom("run:r-attacker", attacker)).toBe(true);
        expect(inRoom("run:r-bystander", bystander)).toBe(true);
      });
    } finally {
      attacker.close();
      bystander.close();
      process.off("uncaughtException", onCrash);
      process.off("unhandledRejection", onCrash);
    }
  });

  it("logs nothing for a handler that succeeds", async () => {
    const socket = await connect();
    socket.emit("subscribe:bg-run", { runId: "r-ok" });
    await vi.waitFor(() => expect(inRoom("run:r-ok", socket)).toBe(true));
    expect(error).not.toHaveBeenCalled();
    socket.close();
  });

  it("returns a promise that waits for an async handler and never rejects", async () => {
    const listeners = new Map<string, (...args: unknown[]) => unknown>();
    const fake = {
      id: "fake-1",
      on: (event: string, listener: (...args: unknown[]) => unknown) => {
        listeners.set(event, listener);
      },
    };
    const order: string[] = [];
    onClientEvent(fake, "subscribe:job", async (payload) => {
      await new Promise((r) => setTimeout(r, 5));
      order.push(payload.jobId);
    });
    onClientEvent(fake, "subscribe:session", async () => {
      throw new Error("db down");
    });
    onClientEvent(fake, "unsubscribe:job", () => undefined);

    await expect(listeners.get("subscribe:job")!({ jobId: "j1" })).resolves.toBeUndefined();
    expect(order).toEqual(["j1"]);
    await expect(listeners.get("subscribe:session")!({ sessionId: "s1" })).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      "Socket handler failed",
      expect.objectContaining({ event: "subscribe:session", socketId: "fake-1", error: "db down" }),
    );
    expect(listeners.get("unsubscribe:job")!({ jobId: "j1" })).toBeUndefined();
  });
});
