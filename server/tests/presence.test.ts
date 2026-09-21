/**
 * Epic #728 / Issue #732 — Socket.IO presence rooms tests.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
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
    to: vi.fn((_room: string) => roomEmitter as ReturnType<MetisIOServer["to"]>),
  };

  return { mockIo: mockIo as MetisIOServer, mockSocket, socketListeners, emittedEvents, rooms };
}

// ---- Tests -----------------------------------------------------------------

describe("wirePresenceHandlers", () => {
  beforeEach(() => {
    clearPresenceState();
    vi.clearAllMocks();
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
    await socketListeners["presence:join"]?.({ artifactType: "requirement", artifactId: "req-1" });

    expect(mockSocket.join).toHaveBeenCalledWith("presence:requirement:req-1");
    expect(emittedEvents.some((e) => e.event === "presence:update")).toBe(true);
    expect(getRoomPresence().get("presence:requirement:req-1")?.size).toBe(1);
  });

  it("removes user from room on presence:leave", async () => {
    const { mockIo, mockSocket, socketListeners } = createMockIo();
    wirePresenceHandlers(mockIo);
    const connectionHandler = vi
      .mocked(mockIo.on)
      .mock.calls.find(([e]) => e === "connection")?.[1];
    connectionHandler!(mockSocket);
    await socketListeners["presence:join"]?.({ artifactType: "requirement", artifactId: "req-1" });
    await socketListeners["presence:leave"]?.({ artifactType: "requirement", artifactId: "req-1" });

    expect(mockSocket.leave).toHaveBeenCalledWith("presence:requirement:req-1");
    expect(getRoomPresence().has("presence:requirement:req-1")).toBe(false);
  });

  it("removes user from all rooms on disconnect", async () => {
    const { mockIo, mockSocket, socketListeners } = createMockIo();
    wirePresenceHandlers(mockIo);
    const connectionHandler = vi
      .mocked(mockIo.on)
      .mock.calls.find(([e]) => e === "connection")?.[1];
    connectionHandler!(mockSocket);
    await socketListeners["presence:join"]?.({ artifactType: "requirement", artifactId: "req-1" });
    await socketListeners["presence:join"]?.({ artifactType: "requirement", artifactId: "req-2" });

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

  it("rejects joining when room cap (50) is reached", async () => {
    const { mockIo, mockSocket, socketListeners } = createMockIo();
    wirePresenceHandlers(mockIo);
    const connectionHandler = vi
      .mocked(mockIo.on)
      .mock.calls.find(([e]) => e === "connection")?.[1];
    connectionHandler!(mockSocket);

    // Join 50 distinct rooms.
    for (let i = 0; i < 50; i++) {
      await socketListeners["presence:join"]?.({ artifactType: "req", artifactId: String(i) });
    }
    expect(mockSocket.join).toHaveBeenCalledTimes(50);

    // 51st join should be rejected.
    vi.clearAllMocks();
    await socketListeners["presence:join"]?.({ artifactType: "req", artifactId: "overflow" });
    expect(mockSocket.join).not.toHaveBeenCalled();
    expect(mockSocket.emit).toHaveBeenCalledWith(
      "presence:error",
      expect.objectContaining({ message: expect.any(String) }),
    );
  });
});
