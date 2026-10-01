/**
 * Epic #728 / Issue #732 — Socket.IO presence rooms tests.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// #679 — the join's access rule is `canJoinPresenceRoom` (covered against its
// lookups in `socket.test.ts`); here it admits unless a test says otherwise.
const access = vi.hoisted(() => ({
  check: vi.fn(async (..._args: unknown[]): Promise<boolean> => true),
}));
vi.mock("../src/lib/socket/room-access.js", () => ({
  canJoinPresenceRoom: (...args: unknown[]) => access.check(...args),
}));

import {
  wirePresenceHandlers,
  getRoomPresence,
  clearPresenceState,
} from "../src/lib/collaboration/presence.js";
import type { MetisIOServer } from "../src/lib/socket/server.js";

// ---- Mock Socket.IO server -------------------------------------------------

function createMockIo() {
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  const socketListeners: Record<string, (...args: unknown[]) => void> = {};
  const rooms = new Set<string>();
  const emittedEvents: Array<{ room: string; event: string; data: unknown }> = [];

  const mockSocket = {
    id: "socket-1",
    data: {
      user: {
        userId: "user-1",
        username: "alice",
        role: "developer",
        permissions: [] as string[],
      },
    },
    join: vi.fn(async (room: string) => rooms.add(room)),
    leave: vi.fn(async (room: string) => rooms.delete(room)),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      socketListeners[event] = handler;
    }),
    emit: vi.fn(),
  };

  const roomEmitter = {
    emit: (event: string, data: unknown) => {
      emittedEvents.push({ room: "_", event, data });
    },
  };

  const mockIo: Partial<MetisIOServer> = {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(handler);
    }),
    // #622 — presence lists are emitted to this replica only (`io.local.to`); no
    // `to` here, so a cluster-wide `io.to(...).emit` would throw.
    local: {
      to: vi.fn((_room: string) => roomEmitter as ReturnType<MetisIOServer["to"]>),
    } as unknown as MetisIOServer["local"],
  };

  return { mockIo: mockIo as MetisIOServer, mockSocket, socketListeners, emittedEvents, rooms };
}

// ---- Tests -----------------------------------------------------------------

describe("wirePresenceHandlers", () => {
  beforeEach(() => {
    clearPresenceState();
    vi.clearAllMocks();
    access.check.mockReset();
    access.check.mockResolvedValue(true);
  });

  it("broadcasts presence:update when a user joins", async () => {
    const { mockIo, mockSocket, socketListeners, emittedEvents } = createMockIo();
    wirePresenceHandlers(mockIo);

    // Simulate socket connection
    const connectionHandler = vi
      .mocked(mockIo.on)
      .mock.calls.find(([e]) => e === "connection")?.[1];
    expect(connectionHandler).toBeDefined();
    connectionHandler!(mockSocket);

    // Simulate presence:join
    await socketListeners["presence:join"]?.({ artifactType: "discussion", artifactId: "req-1" });

    expect(mockSocket.join).toHaveBeenCalledWith("presence:discussion:req-1");
    expect(emittedEvents.some((e) => e.event === "presence:update")).toBe(true);
    expect(getRoomPresence().get("presence:discussion:req-1")?.size).toBe(1);
  });

  it("removes user from room on presence:leave", async () => {
    const { mockIo, mockSocket, socketListeners } = createMockIo();
    wirePresenceHandlers(mockIo);
    const connectionHandler = vi
      .mocked(mockIo.on)
      .mock.calls.find(([e]) => e === "connection")?.[1];
    connectionHandler!(mockSocket);
    await socketListeners["presence:join"]?.({ artifactType: "discussion", artifactId: "req-1" });
    await socketListeners["presence:leave"]?.({ artifactType: "discussion", artifactId: "req-1" });

    expect(mockSocket.leave).toHaveBeenCalledWith("presence:discussion:req-1");
    expect(getRoomPresence().has("presence:discussion:req-1")).toBe(false);
  });

  it("removes user from all rooms on disconnect", async () => {
    const { mockIo, mockSocket, socketListeners } = createMockIo();
    wirePresenceHandlers(mockIo);
    const connectionHandler = vi
      .mocked(mockIo.on)
      .mock.calls.find(([e]) => e === "connection")?.[1];
    connectionHandler!(mockSocket);
    await socketListeners["presence:join"]?.({ artifactType: "discussion", artifactId: "req-1" });
    await socketListeners["presence:join"]?.({ artifactType: "discussion", artifactId: "req-2" });

    expect(getRoomPresence().size).toBe(2);
    socketListeners["disconnect"]?.("transport close");
    expect(getRoomPresence().size).toBe(0);
  });

  it("ignores presence:join with invalid data", async () => {
    const { mockIo, mockSocket, socketListeners } = createMockIo();
    wirePresenceHandlers(mockIo);
    const connectionHandler = vi
      .mocked(mockIo.on)
      .mock.calls.find(([e]) => e === "connection")?.[1];
    connectionHandler!(mockSocket);
    await socketListeners["presence:join"]?.({ artifactType: 123, artifactId: null });

    expect(mockSocket.join).not.toHaveBeenCalled();
    expect(getRoomPresence().size).toBe(0);
  });

  // #676 — a free-form artifact type could make two `type:id` pairs share one
  // room (`a:b` + `c` and `a` + `b:c`), so only a listed type is honoured.
  it.each([["requirement"], ["discussion:x"], ["spec-kit"]])(
    "ignores presence:join and presence:leave with the unlisted artifact type %j",
    async (artifactType) => {
      const { mockIo, mockSocket, socketListeners, emittedEvents } = createMockIo();
      wirePresenceHandlers(mockIo);
      const connectionHandler = vi
        .mocked(mockIo.on)
        .mock.calls.find(([e]) => e === "connection")?.[1];
      connectionHandler!(mockSocket);
      await socketListeners["presence:join"]?.({ artifactType, artifactId: "x" });
      await socketListeners["presence:leave"]?.({ artifactType, artifactId: "x" });

      expect(mockSocket.join).not.toHaveBeenCalled();
      expect(mockSocket.leave).not.toHaveBeenCalled();
      expect(emittedEvents.some((e) => e.event === "presence:update")).toBe(false);
      expect(getRoomPresence().size).toBe(0);
    },
  );

  it("joins the room for every listed artifact type", async () => {
    const { mockIo, mockSocket, socketListeners } = createMockIo();
    wirePresenceHandlers(mockIo);
    const connectionHandler = vi
      .mocked(mockIo.on)
      .mock.calls.find(([e]) => e === "connection")?.[1];
    connectionHandler!(mockSocket);
    await socketListeners["presence:join"]?.({
      artifactType: "spec-kit-artifact",
      artifactId: "p:a",
    });

    expect(mockSocket.join).toHaveBeenCalledWith("presence:spec-kit-artifact:p:a");
  });

  // #654 — a destructured null payload rejected the async handler, an
  // unhandled rejection that crashed the API process.
  it("ignores a null or missing payload on presence:join and presence:leave", async () => {
    const { mockIo, mockSocket, socketListeners } = createMockIo();
    wirePresenceHandlers(mockIo);
    const connectionHandler = vi
      .mocked(mockIo.on)
      .mock.calls.find(([e]) => e === "connection")?.[1];
    connectionHandler!(mockSocket);
    for (const event of ["presence:join", "presence:leave"]) {
      // A listener that is not registered must fail here, not resolve vacuously.
      const listener = socketListeners[event];
      expect(listener, `no listener registered for ${event}`).toBeTypeOf("function");
      await expect(listener!(null)).resolves.toBeUndefined();
      await expect(listener!()).resolves.toBeUndefined();
    }
    expect(mockSocket.join).not.toHaveBeenCalled();
    expect(mockSocket.leave).not.toHaveBeenCalled();
    expect(getRoomPresence().size).toBe(0);
  });

  it("rejects joining when room cap (50) is reached", async () => {
    const { mockIo, mockSocket, socketListeners } = createMockIo();
    wirePresenceHandlers(mockIo);
    const connectionHandler = vi
      .mocked(mockIo.on)
      .mock.calls.find(([e]) => e === "connection")?.[1];
    connectionHandler!(mockSocket);

    // Join 50 distinct rooms.
    for (let i = 0; i < 50; i++) {
      await socketListeners["presence:join"]?.({
        artifactType: "discussion",
        artifactId: String(i),
      });
    }
    expect(mockSocket.join).toHaveBeenCalledTimes(50);

    // 51st join should be rejected.
    vi.clearAllMocks();
    await socketListeners["presence:join"]?.({
      artifactType: "discussion",
      artifactId: "overflow",
    });
    expect(mockSocket.join).not.toHaveBeenCalled();
    expect(mockSocket.emit).toHaveBeenCalledWith(
      "presence:error",
      expect.objectContaining({ message: expect.any(String) }),
    );
  });
});

// #679 — a presence room lists who is viewing an artifact, so the join takes
// the artifact's REST read rule.
describe("presence:join access (#679)", () => {
  beforeEach(() => {
    clearPresenceState();
    vi.clearAllMocks();
    access.check.mockReset();
  });

  function connect() {
    const ctx = createMockIo();
    wirePresenceHandlers(ctx.mockIo);
    const connectionHandler = vi
      .mocked(ctx.mockIo.on)
      .mock.calls.find(([e]) => e === "connection")?.[1];
    connectionHandler!(ctx.mockSocket);
    return ctx;
  }

  /** An access check the test resolves by hand. */
  function deferredCheck() {
    let resolve!: (allowed: boolean) => void;
    access.check.mockImplementationOnce(() => new Promise<boolean>((r) => (resolve = r)));
    return (allowed: boolean) => resolve(allowed);
  }

  const ARTIFACT = { artifactType: "discussion", artifactId: "t1" } as const;
  const ROOM = "presence:discussion:t1";

  it("checks the joining user against the named artifact", async () => {
    access.check.mockResolvedValue(true);
    const { mockSocket, socketListeners } = connect();
    await socketListeners["presence:join"]?.({
      artifactType: "spec-kit-artifact",
      artifactId: "p1:spec.md",
    });
    expect(access.check).toHaveBeenCalledWith(
      mockSocket.data.user,
      "spec-kit-artifact",
      "p1:spec.md",
    );
    expect(mockSocket.join).toHaveBeenCalledWith("presence:spec-kit-artifact:p1:spec.md");
  });

  it.each([
    ["a refusal", () => access.check.mockResolvedValue(false)],
    ["a failed lookup", () => access.check.mockRejectedValue(new Error("db down"))],
  ])("answers %s with one room-scoped auth:error and no join", async (_label, arrange) => {
    arrange();
    const { mockSocket, socketListeners, emittedEvents } = connect();
    await expect(socketListeners["presence:join"]?.(ARTIFACT)).resolves.toBeUndefined();

    expect(mockSocket.join).not.toHaveBeenCalled();
    expect(mockSocket.emit).toHaveBeenCalledTimes(1);
    expect(mockSocket.emit).toHaveBeenCalledWith("auth:error", {
      message: "FORBIDDEN: no access to artifact",
      room: ROOM,
    });
    expect(emittedEvents).toEqual([]);
    expect(getRoomPresence().size).toBe(0);
  });

  it("does not join when the socket leaves before the check resolves", async () => {
    const settle = deferredCheck();
    const { mockSocket, socketListeners, emittedEvents } = connect();
    const joining = socketListeners["presence:join"]?.(ARTIFACT);
    await socketListeners["presence:leave"]?.(ARTIFACT);
    emittedEvents.length = 0;
    settle(true);
    await joining;

    expect(mockSocket.join).not.toHaveBeenCalled();
    expect(mockSocket.emit).not.toHaveBeenCalled();
    expect(emittedEvents).toEqual([]);
    expect(getRoomPresence().size).toBe(0);
  });

  it("does not list a socket that disconnected before the check resolved", async () => {
    const settle = deferredCheck();
    const { mockSocket, socketListeners, emittedEvents } = connect();
    const joining = socketListeners["presence:join"]?.(ARTIFACT);
    socketListeners["disconnect"]?.("transport close");
    settle(true);
    await joining;

    expect(mockSocket.join).not.toHaveBeenCalled();
    expect(emittedEvents).toEqual([]);
    expect(getRoomPresence().size).toBe(0);
  });

  it("acts on the newest join when an older check resolves after it", async () => {
    const settleFirst = deferredCheck();
    const settleSecond = deferredCheck();
    const { mockSocket, socketListeners } = connect();
    const first = socketListeners["presence:join"]?.(ARTIFACT);
    const second = socketListeners["presence:join"]?.(ARTIFACT);
    settleFirst(true);
    await first;
    expect(mockSocket.join).not.toHaveBeenCalled();
    settleSecond(true);
    await second;
    expect(mockSocket.join).toHaveBeenCalledTimes(1);
    expect(getRoomPresence().get(ROOM)?.size).toBe(1);
  });

  it("counts joins still being checked against the room cap", async () => {
    access.check.mockImplementation(() => new Promise<boolean>(() => {}));
    const { mockSocket, socketListeners } = connect();
    for (let i = 0; i < 50; i++) {
      void socketListeners["presence:join"]?.({ artifactType: "discussion", artifactId: `${i}` });
    }
    await socketListeners["presence:join"]?.({ artifactType: "discussion", artifactId: "x" });

    expect(access.check).toHaveBeenCalledTimes(50);
    expect(mockSocket.emit).toHaveBeenCalledWith("presence:error", {
      message: "Maximum room limit reached",
    });
  });
});
