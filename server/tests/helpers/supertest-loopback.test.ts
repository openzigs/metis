import { createServer, type Server } from "node:http";
import { once } from "node:events";
import request from "supertest";
import { describe, expect, it } from "vitest";

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe("Supertest loopback isolation", () => {
  it("addresses a wildcard fixture via IPv6 instead of another IPv4 fixture", async () => {
    const other = createServer((_req, res) => res.writeHead(404).end("wrong fixture"));
    const server = createServer((_req, res) => res.end("correct fixture"));
    try {
      other.listen(0, "127.0.0.1");
      await once(other, "listening");
      const otherAddress = other.address();
      if (!otherAddress || typeof otherAddress === "string") throw new Error("Missing TCP port");
      // ipv6Only reproduces macOS's dual-stack collision on Linux as well.
      server.listen({ port: otherAddress.port, host: "::", ipv6Only: true });
      await once(server, "listening");
      const pending = request(server).get("/fixture");
      const address = server.address();
      expect(address).toMatchObject({ address: "::", family: "IPv6" });
      expect(pending.url).toMatch(/^http:\/\/\[::1\]:\d+\/fixture$/);
      const response = await pending;
      expect(response.status).toBe(200);
      expect(response.text).toBe("correct fixture");
    } finally {
      await close(server);
      await close(other);
    }
  });

  it("preserves explicitly bound IPv4 listeners after the previous test restores mocks", async () => {
    const server = createServer((_req, res) => res.end("ipv4 fixture"));
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const pending = request(server).get("/fixture");
      expect(pending.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/fixture$/);
      expect((await pending).text).toBe("ipv4 fixture");
    } finally {
      await close(server);
    }
  });

  it("reinstalls IPv6 isolation after restoreAllMocks", async () => {
    const server = createServer((_req, res) => res.end("fresh fixture"));
    try {
      const pending = request(server).get("/fixture");
      expect(pending.url).toMatch(/^http:\/\/\[::1\]:\d+\/fixture$/);
      expect((await pending).text).toBe("fresh fixture");
    } finally {
      await close(server);
    }
  });
});
