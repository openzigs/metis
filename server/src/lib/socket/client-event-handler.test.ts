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

import { onClientEvent, onConnection, runDetached } from "./client-event-handler.js";

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

  it("contains a rejecting non-native thenable (a lazy PrismaPromise returned directly)", async () => {
    const listeners = new Map<string, (...args: unknown[]) => unknown>();
    const fake = {
      id: "fake-2",
      on: (event: string, listener: (...args: unknown[]) => unknown) => {
        listeners.set(event, listener);
      },
    };
    // Lazy like a PrismaPromise: the work runs only when `then` is called, and
    // it is not a native Promise, so an `instanceof Promise` check misses it.
    let started = 0;
    const lazyRejecting: PromiseLike<never> = {
      then(_onFulfilled, onRejected) {
        started += 1;
        setTimeout(() => onRejected?.(new Error("lazy boom")), 0);
        return this as never;
      },
    };
    expect(lazyRejecting instanceof Promise).toBe(false);
    onClientEvent(fake, "subscribe:job", () => lazyRejecting);
    // A `then` that throws synchronously is a rejection too, not an escape.
    onClientEvent(fake, "unsubscribe:job", () => ({
      then() {
        throw new Error("then threw");
      },
    }));

    await listeners.get("subscribe:job")!({ jobId: "j1" });
    // The wrapper subscribed to the thenable (so the lazy work ran) and logged
    // its rejection.
    expect(started).toBe(1);
    expect(error).toHaveBeenCalledWith(
      "Socket handler failed",
      expect.objectContaining({ event: "subscribe:job", socketId: "fake-2", error: "lazy boom" }),
    );
    await listeners.get("unsubscribe:job")!({ jobId: "j1" });
    expect(error).toHaveBeenCalledWith(
      "Socket handler failed",
      expect.objectContaining({ event: "unsubscribe:job", error: "then threw" }),
    );
  });
});

describe("#658 runDetached contains a rejection nothing waits on", () => {
  it("logs a rejecting promise or lazy thenable, ignores a plain value, and never escapes", async () => {
    const crashes: unknown[] = [];
    const onCrash = (err: unknown): void => {
      crashes.push(err);
    };
    process.on("unhandledRejection", onCrash);
    try {
      let started = 0;
      const lazy: PromiseLike<never> = {
        then(_f, onRejected) {
          started += 1;
          onRejected?.("lazy reason");
          return this as never;
        },
      };
      expect(runDetached(Promise.reject(new Error("join failed")), "join", "s-1")).toBeUndefined();
      runDetached(lazy, "lazy", "s-2");
      runDetached(undefined, "sync join");
      await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(2));
      await new Promise((r) => setTimeout(r, 20));
      expect(crashes).toEqual([]);
      expect(started).toBe(1);
      expect(error).toHaveBeenCalledWith(
        "Detached socket work failed",
        expect.objectContaining({ what: "join", socketId: "s-1", error: "join failed" }),
      );
      expect(error).toHaveBeenCalledWith(
        "Detached socket work failed",
        expect.objectContaining({ what: "lazy", socketId: "s-2", error: "lazy reason" }),
      );
    } finally {
      process.off("unhandledRejection", onCrash);
    }
  });
});

describe("#658 onConnection contains a throw while attaching handlers", () => {
  it("logs the throw, disconnects that socket, and leaves the process alive", () => {
    let listener: ((socket: { id: string; disconnect: () => void }) => void) | undefined;
    const fakeIo = {
      on: (_event: "connection", l: (socket: { id: string; disconnect: () => void }) => void) => {
        listener = l;
      },
    };
    const attached: string[] = [];
    onConnection(fakeIo, (socket) => {
      if (socket.id === "bad") throw new Error("attach boom");
      attached.push(socket.id);
    });
    const bad = { id: "bad", disconnect: vi.fn() };
    const good = { id: "good", disconnect: vi.fn() };
    expect(() => listener!(bad)).not.toThrow();
    listener!(good);
    expect(bad.disconnect).toHaveBeenCalledWith(true);
    expect(good.disconnect).not.toHaveBeenCalled();
    expect(attached).toEqual(["good"]);
    expect(error).toHaveBeenCalledWith(
      "Socket connection setup failed; disconnecting the socket",
      expect.objectContaining({ socketId: "bad", error: "attach boom" }),
    );
  });

  it("logs, and does not throw, when the disconnect itself throws", () => {
    type Listener = (socket: { id: string; disconnect: () => void }) => void;
    let listener: Listener | undefined;
    const fakeIo = {
      on: (_event: "connection", l: Listener) => {
        listener = l;
      },
    };
    onConnection(fakeIo, () => {
      throw "non-error";
    });
    const socket = {
      id: "s",
      disconnect: () => {
        throw new Error("already gone");
      },
    };
    expect(() => listener!(socket)).not.toThrow();
    expect(error).toHaveBeenCalledWith(
      "Socket connection setup failed; disconnecting the socket",
      expect.objectContaining({ socketId: "s", error: "non-error" }),
    );
    expect(error).toHaveBeenCalledWith(
      "Socket disconnect after a failed setup also failed",
      expect.objectContaining({ socketId: "s", error: "already gone" }),
    );
  });
});
