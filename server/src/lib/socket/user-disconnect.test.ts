/**
 * #612 — the disconnect runs after the deprovision has committed, so an
 * adapter error must be logged, never thrown into the SCIM route.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { disconnectUserSockets } from "./user-disconnect.js";
import { registerSocketServer } from "./registry.js";
import type { MetisIOServer } from "./server.js";

describe("disconnectUserSockets", () => {
  afterEach(() => registerSocketServer(null as unknown as MetisIOServer));

  it("disconnects the user's personal room, closing the connection", () => {
    const disconnectSockets = vi.fn();
    const io = { in: vi.fn(() => ({ disconnectSockets })) } as unknown as MetisIOServer;
    registerSocketServer(io);
    disconnectUserSockets("u-1");
    expect(io.in).toHaveBeenCalledWith("user:u-1");
    expect(disconnectSockets).toHaveBeenCalledWith(true);
  });

  it("does not throw when the adapter fails", () => {
    const io = {
      in: vi.fn(() => ({
        disconnectSockets: () => {
          throw new Error("adapter down");
        },
      })),
    } as unknown as MetisIOServer;
    registerSocketServer(io);
    expect(() => disconnectUserSockets("u-1")).not.toThrow();
  });

  it("is a no-op with no registered server", () => {
    registerSocketServer(null as unknown as MetisIOServer);
    expect(() => disconnectUserSockets("u-1")).not.toThrow();
  });
});
