import type { Server } from "node:http";
import request from "supertest";
import { vi } from "vitest";

const prototype = request.Test.prototype as unknown as {
  serverAddress(server: Server, path: string): string;
};
const serverAddress = prototype.serverAddress;

/** Keep Supertest on its own listener's address family, not a parallel fixture's. */
export function isolateSupertestLoopback(): void {
  vi.spyOn(prototype, "serverAddress").mockImplementation(function (server, path) {
    const url = serverAddress.call(this, server, path);
    const address = server.address();
    // Supertest listens on :: but hardcodes 127.0.0.1. On macOS a separate
    // IPv4-only server can own the same port and receive that request instead.
    return address && typeof address !== "string" && address.address === "::"
      ? url.replace("://127.0.0.1:", "://[::1]:")
      : url;
  });
}
