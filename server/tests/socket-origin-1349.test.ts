/**
 * #1349 — a cookie-authenticated socket.io handshake refuses a foreign Origin
 * (cross-site WebSocket hijacking). `SameSite=Lax` keeps the session cookie off
 * a cross-SITE request but not off one from a sibling subdomain, so without
 * this check a page there could open a socket as the signed-in user.
 *
 * Allowed: an Origin naming the API's own host, an entry of `CORS_ORIGIN`
 * (the browser UI connects straight to the API from that origin), and an entry
 * of `METIS_TRUSTED_ORIGINS`. A handshake with no Origin at all is not a
 * browser that could be forged into sending the cookie, so it passes. A
 * handshake authenticated by a token (`auth.token` or a bearer header) is not
 * checked: a foreign page cannot read the token to present it.
 */
import http from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { io as ioClient } from "socket.io-client";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    $queryRawUnsafe: vi.fn(async () => 1),
    user: {
      upsert: vi.fn(),
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        username: "testuser",
        authRoleAuthority: null,
      })),
    },
    userRole: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => [{ source: "local", role: { key: "developer" } }]),
    },
    workspaceMember: { findMany: vi.fn(async () => []) },
    auditLog: { create: vi.fn(async () => ({})) },
    project: { findMany: vi.fn(async () => []) },
  },
}));

import { createSocketServer, type MetisIOServer } from "../src/lib/socket/server.js";
import { issueTokens } from "../src/lib/auth/jwt.js";

const UI_ORIGIN = "http://ui.metis.test:3000";
const TRUSTED_ORIGIN = "https://proxy.metis.test";

let httpServer: http.Server;
let io: MetisIOServer;
let port: number;

beforeAll(async () => {
  vi.stubEnv("METIS_TRUSTED_ORIGINS", ` ${TRUSTED_ORIGIN} , not a url`);
  httpServer = http.createServer();
  io = createSocketServer(httpServer, { corsOrigin: `https://other.metis.test, ${UI_ORIGIN}` });
  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => {
      const addr = httpServer.address();
      if (addr && typeof addr === "object") port = addr.port;
      resolve();
    });
  });
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await io.close();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

const open: Array<{ close: () => void }> = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
});

function token(userId: string): string {
  return issueTokens({ userId, username: userId, role: "developer", permissions: [] }).accessToken;
}

type Outcome = { ok: true } | { ok: false; message: string };

function handshake(opts: {
  headers: Record<string, string>;
  auth?: Record<string, string>;
  transport?: "websocket" | "polling";
}): Promise<Outcome> {
  return new Promise((resolve) => {
    const socket = ioClient(`http://127.0.0.1:${port}`, {
      transports: [opts.transport ?? "websocket"],
      extraHeaders: opts.headers,
      ...(opts.auth ? { auth: opts.auth } : {}),
      reconnection: false,
      timeout: 2000,
    });
    open.push(socket);
    socket.on("auth:ok", () => resolve({ ok: true }));
    socket.on("connect_error", (err) => resolve({ ok: false, message: err.message }));
  });
}

const cookie = (userId: string) => `metis.at=${token(userId)}`;

describe("#1349 — socket.io handshake Origin check", () => {
  it("refuses a cookie-authenticated handshake from a foreign Origin", async () => {
    const res = await handshake({
      headers: { cookie: cookie("u-1349-evil"), origin: "https://evil.metis.test" },
    });
    expect(res).toEqual({ ok: false, message: "ORIGIN_REJECTED" });
  });

  it("refuses it over the polling transport too", async () => {
    const res = await handshake({
      transport: "polling",
      headers: { cookie: cookie("u-1349-evil-poll"), origin: "https://evil.metis.test" },
    });
    expect(res).toEqual({ ok: false, message: "ORIGIN_REJECTED" });
    // ...and admits the UI's origin over it.
    expect(
      await handshake({
        transport: "polling",
        headers: { cookie: cookie("u-1349-ui-poll"), origin: UI_ORIGIN },
      }),
    ).toEqual({ ok: true });
  });

  it("answers a polling request from either CORS_ORIGIN entry with that origin's CORS header", async () => {
    // A Node client ignores CORS headers, so read them off the raw response: the
    // comma list must reach socket.io's `cors` parsed, not as one string (#913).
    for (const origin of [UI_ORIGIN, "https://other.metis.test"]) {
      const res = await fetch(`http://127.0.0.1:${port}/socket.io/?EIO=4&transport=polling`, {
        headers: { origin },
      });
      await res.text();
      expect(res.headers.get("access-control-allow-origin")).toBe(origin);
      expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    }
  });

  it("refuses an opaque (null) Origin", async () => {
    const res = await handshake({
      headers: { cookie: cookie("u-1349-null"), origin: "null" },
    });
    expect(res).toEqual({ ok: false, message: "ORIGIN_REJECTED" });
  });

  it("refuses a look-alike that only shares a prefix with a CORS_ORIGIN entry", async () => {
    const res = await handshake({
      headers: { cookie: cookie("u-1349-prefix"), origin: `${UI_ORIGIN}.evil.test` },
    });
    expect(res).toEqual({ ok: false, message: "ORIGIN_REJECTED" });
  });

  it("admits every CORS_ORIGIN entry (the browser UI connects straight to the API)", async () => {
    expect(
      await handshake({ headers: { cookie: cookie("u-1349-ui"), origin: UI_ORIGIN } }),
    ).toEqual({ ok: true });
    expect(
      await handshake({
        headers: { cookie: cookie("u-1349-ui2"), origin: "https://other.metis.test" },
      }),
    ).toEqual({ ok: true });
  });

  it("admits a METIS_TRUSTED_ORIGINS entry", async () => {
    const res = await handshake({
      headers: { cookie: cookie("u-1349-trusted"), origin: TRUSTED_ORIGIN },
    });
    expect(res).toEqual({ ok: true });
  });

  it("admits the API's own origin", async () => {
    const res = await handshake({
      headers: { cookie: cookie("u-1349-self"), origin: `http://127.0.0.1:${port}` },
    });
    expect(res).toEqual({ ok: true });
  });

  it("admits a cookie handshake with no Origin (not a browser)", async () => {
    const res = await handshake({ headers: { cookie: cookie("u-1349-none") } });
    expect(res).toEqual({ ok: true });
  });

  it("does not check Origin on a token-authenticated handshake", async () => {
    expect(
      await handshake({
        headers: { origin: "https://evil.metis.test" },
        auth: { token: token("u-1349-token") },
      }),
    ).toEqual({ ok: true });
    expect(
      await handshake({
        headers: {
          origin: "https://evil.metis.test",
          authorization: `Bearer ${token("u-1349-bearer")}`,
        },
      }),
    ).toEqual({ ok: true });
  });

  it("an auth.token does not launder a cookie: the cookie is not what authenticates", async () => {
    // A foreign page can set auth.token to anything; an invalid one is refused
    // on its own merits rather than falling back to the cookie.
    const res = await handshake({
      headers: { cookie: cookie("u-1349-launder"), origin: "https://evil.metis.test" },
      auth: { token: "not-a-jwt" },
    });
    expect(res.ok).toBe(false);
  });
});
