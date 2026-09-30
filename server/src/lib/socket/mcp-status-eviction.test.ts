/**
 * #588 review — eviction runs after the database write has committed, so an
 * adapter error must be logged, never thrown into the route.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { evictMemberMcpStatusRoom, evictWorkspaceMcpStatusRoom } from "./mcp-status-eviction.js";
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
