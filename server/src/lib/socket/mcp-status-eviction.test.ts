/**
 * #588 review — eviction runs after the database write has committed, so an
 * adapter error must be logged, never thrown into the route.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EVICT_MEMBER_EVENT,
  EVICT_WORKSPACE_EVENT,
  evictMemberMcpStatusRoom,
  evictWorkspaceMcpStatusRoom,
  mcpStatusEvictionEpoch,
  wireMcpStatusEvictionRelay,
} from "./mcp-status-eviction.js";
import { registerSocketServer } from "./registry.js";
import type { MetisIOServer } from "./server.js";

function throwingServer(): MetisIOServer {
  const socketsLeave = vi.fn(() => {
    throw new Error("adapter down");
  });
  return {
    socketsLeave,
    in: vi.fn(() => ({ socketsLeave })),
  } as unknown as MetisIOServer;
}

describe("mcp-status-eviction is best-effort", () => {
  afterEach(() => registerSocketServer(null as unknown as MetisIOServer));

  it("does not throw when the adapter fails on a workspace eviction", () => {
    const io = throwingServer();
    registerSocketServer(io);
    expect(() => evictWorkspaceMcpStatusRoom("ws-1")).not.toThrow();
    expect(io.socketsLeave).toHaveBeenCalledWith("mcp:status:workspace:ws-1");
  });

  it("does not throw when the adapter fails on a member eviction", () => {
    const io = throwingServer();
    registerSocketServer(io);
    expect(() => evictMemberMcpStatusRoom("u-1", "ws-1")).not.toThrow();
    expect(io.in).toHaveBeenCalledWith("user:u-1");
  });

  it("is a no-op with no registered server", () => {
    registerSocketServer(null as unknown as MetisIOServer);
    expect(() => evictWorkspaceMcpStatusRoom("ws-1")).not.toThrow();
    expect(() => evictMemberMcpStatusRoom("u-1", "ws-1")).not.toThrow();
  });
});

// #622 / #613 — with the cluster adapter, every eviction also moves the other
// replicas' eviction epochs, so a `subscribe:mcp` in flight there re-reads.
describe("mcp-status-eviction relay", () => {
  afterEach(() => registerSocketServer(null as unknown as MetisIOServer));

  function relayServer() {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const localLeave = vi.fn();
    const localIn = vi.fn(() => ({ socketsLeave: localLeave }));
    const io = {
      socketsLeave: vi.fn(),
      in: vi.fn(() => ({ socketsLeave: vi.fn() })),
      local: { socketsLeave: localLeave, in: localIn },
      on: vi.fn((event: string, fn: (...args: unknown[]) => void) => listeners.set(event, fn)),
      serverSideEmit: vi.fn(),
    };
    return { io, server: io as unknown as MetisIOServer, listeners, localLeave, localIn };
  }

  it("bumps the local epoch before evicting, and relays each eviction when clustered", () => {
    const { io, server } = relayServer();
    wireMcpStatusEvictionRelay(server, true);
    registerSocketServer(server);
    let epochAtLeave = -1;
    io.socketsLeave.mockImplementation(() => {
      epochAtLeave = mcpStatusEvictionEpoch(server);
    });
    evictWorkspaceMcpStatusRoom("ws-1");
    expect(epochAtLeave).toBe(1);
    evictMemberMcpStatusRoom("u-1", "ws-2");
    expect(mcpStatusEvictionEpoch(server)).toBe(2);
    expect(io.serverSideEmit).toHaveBeenCalledWith(EVICT_WORKSPACE_EVENT, "ws-1");
    expect(io.serverSideEmit).toHaveBeenCalledWith(EVICT_MEMBER_EVENT, "u-1", "ws-2");
  });

  it("neither relays nor listens without the cluster adapter", () => {
    const { io, server } = relayServer();
    wireMcpStatusEvictionRelay(server, false);
    registerSocketServer(server);
    evictWorkspaceMcpStatusRoom("ws-1");
    expect(io.on).not.toHaveBeenCalled();
    expect(io.serverSideEmit).not.toHaveBeenCalled();
    expect(mcpStatusEvictionEpoch(server)).toBe(1);
  });

  it("a relayed eviction bumps this replica's epoch and repeats the leave on local sockets", () => {
    const { server, listeners, localLeave, localIn } = relayServer();
    wireMcpStatusEvictionRelay(server, true);
    listeners.get(EVICT_WORKSPACE_EVENT)!("ws-1");
    expect(mcpStatusEvictionEpoch(server)).toBe(1);
    expect(localLeave).toHaveBeenCalledWith("mcp:status:workspace:ws-1");
    listeners.get(EVICT_MEMBER_EVENT)!("u-1", "ws-2");
    expect(mcpStatusEvictionEpoch(server)).toBe(2);
    expect(localIn).toHaveBeenCalledWith("user:u-1");
    expect(localLeave).toHaveBeenCalledWith("mcp:status:workspace:ws-2");
  });

  it("ignores a malformed relay and never throws from a failing local leave", () => {
    const { server, listeners, localLeave } = relayServer();
    wireMcpStatusEvictionRelay(server, true);
    listeners.get(EVICT_WORKSPACE_EVENT)!(42);
    listeners.get(EVICT_MEMBER_EVENT)!("u-1");
    listeners.get(EVICT_MEMBER_EVENT)!("u-1", "");
    expect(mcpStatusEvictionEpoch(server)).toBe(0);
    expect(localLeave).not.toHaveBeenCalled();
    localLeave.mockImplementation(() => {
      throw new Error("adapter down");
    });
    expect(() => listeners.get(EVICT_WORKSPACE_EVENT)!("ws-1")).not.toThrow();
  });

  it("never throws when the relay itself fails", () => {
    const { io, server } = relayServer();
    io.serverSideEmit.mockImplementation(() => {
      throw new Error("adapter down");
    });
    wireMcpStatusEvictionRelay(server, true);
    registerSocketServer(server);
    expect(() => evictWorkspaceMcpStatusRoom("ws-1")).not.toThrow();
  });
});
