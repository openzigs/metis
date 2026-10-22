/**
 * #1414 — a live Socket.IO connection no longer outlives the session that
 * opened it:
 *   - its transport closes when its access token expires (a per-socket timer,
 *     and `revalidateLocalSockets` as the backstop), while a client that
 *     re-handshakes with a renewed token stays connected;
 *   - `POST /api/auth/logout` disconnects that session's sockets and no other
 *     session's, and refuses a reconnect with the ended session's token;
 *   - `revokeAllUserSessions` disconnects every socket of the user.
 *
 * Real Socket.IO server and clients, the real auth router (supertest) and the
 * real JWT issuance; the live-user read and the revocation store are stubbed.
 */
import http from "node:http";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import type { AuthPayload } from "@metis/shared";

const live = vi.hoisted(() => ({
  users: new Map<string, AuthPayload | null>(),
  /** While set, every live-user read waits on it — a handshake held in flight. */
  gate: undefined as Promise<void> | undefined,
}));
vi.mock("../src/lib/auth/live-auth-payload.js", () => ({
  loadLiveAuthPayload: vi.fn(async (userId: string) => {
    if (live.gate) await live.gate;
    return live.users.get(userId) ?? null;
  }),
}));
vi.mock("../src/lib/auth/live-workspace-ids.js", () => ({
  readLiveWorkspaceIds: vi.fn(async () => []),
}));
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));
vi.mock("../src/lib/prisma.js", () => ({ prisma: {} }));

import {
  issueTokens,
  refreshAccessToken,
  resolveJwtSecret,
  revokeAllUserSessions,
  sessionIdOf,
  setRevocationStore,
  verifyAccessToken,
} from "../src/lib/auth/jwt.js";
import type { RevocationStore } from "../src/lib/auth/revocation-store.js";
import {
  createSocketServer,
  revalidateLocalSockets,
  type MetisIOServer,
} from "../src/lib/socket/server.js";
import { registerSocketServer } from "../src/lib/socket/registry.js";
import {
  __resetEndedSessionsForTests,
  authSessionRoom,
  disconnectSessionSockets,
  isSessionEnded,
} from "../src/lib/socket/session-disconnect.js";
import { authRouter } from "../src/routes/auth.js";

/** An in-memory revocation store: enough for logout, refresh and revoke-all. */
function memoryStore(): RevocationStore {
  const revoked = new Set<string>();
  const cutoffs = new Map<string, number>();
  const cutOff = (userId: string, iat?: number) =>
    iat !== undefined && cutoffs.has(userId) && iat <= cutoffs.get(userId)!;
  return {
    revokeToken: async (tokenId) => void revoked.add(tokenId),
    claimToken: async (tokenId) => (revoked.has(tokenId) ? false : (revoked.add(tokenId), true)),
    releaseClaim: async (tokenId) => void revoked.delete(tokenId),
    isRevoked: async (tokenId, userId, iat) => revoked.has(tokenId) || cutOff(userId, iat),
    isCutOff: async (userId, iat) => cutOff(userId, iat),
    revokeAllForUser: async (userId) => void cutoffs.set(userId, Math.floor(Date.now() / 1000)),
    clearUserRevocation: async (userId) => void cutoffs.delete(userId),
    isUserRevoked: async (userId) => cutoffs.has(userId),
    pruneExpired: async () => 0,
  };
}

const payload = (userId: string): AuthPayload => ({
  userId,
  username: userId,
  role: "coordinator",
  permissions: [],
  workspaces: [],
});

/** An access token for `userId` in session `sid` that expires in `seconds`. */
function shortToken(userId: string, sid: string, seconds: number): string {
  return jwt.sign({ ...payload(userId), sid }, resolveJwtSecret().secret, { expiresIn: seconds });
}

let httpServer: http.Server;
let io: MetisIOServer;
let port: number;
const open: ClientSocket[] = [];

beforeEach(async () => {
  live.users.clear();
  live.gate = undefined;
  __resetEndedSessionsForTests();
  setRevocationStore(memoryStore());
  httpServer = http.createServer();
  io = createSocketServer(httpServer);
  registerSocketServer(io);
  port = await new Promise<number>((resolve) =>
    httpServer.listen(0, "127.0.0.1", () =>
      resolve((httpServer.address() as { port: number }).port),
    ),
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of open.splice(0)) s.close();
  await io.close();
});

interface Conn {
  socket: ClientSocket;
  reasons: string[];
}

/**
 * Connect with the token `token()` returns at each handshake — how a client
 * that renews its token re-authenticates. Resolves once `auth:ok` arrives.
 */
async function connect(token: () => string, opts: { reconnection?: boolean } = {}): Promise<Conn> {
  const userId = verifyAccessToken(token()).userId;
  if (!live.users.has(userId)) live.users.set(userId, payload(userId));
  const socket = ioClient(`http://127.0.0.1:${port}`, {
    auth: (cb) => cb({ token: token() }),
    transports: ["websocket"],
    reconnection: opts.reconnection ?? false,
    reconnectionDelay: 50,
    reconnectionDelayMax: 50,
  });
  open.push(socket);
  const conn: Conn = { socket, reasons: [] };
  socket.on("disconnect", (reason) => conn.reasons.push(reason));
  await new Promise<void>((resolve, reject) => {
    socket.once("auth:ok", () => resolve());
    socket.once("connect_error", reject);
  });
  return conn;
}

/** The `connect_error` message a fresh handshake with `token` receives, or "connected". */
async function handshakeOutcome(token: string): Promise<string> {
  const socket = ioClient(`http://127.0.0.1:${port}`, {
    auth: { token },
    transports: ["websocket"],
    reconnection: false,
  });
  open.push(socket);
  return new Promise<string>((resolve) => {
    socket.once("auth:ok", () => resolve("connected"));
    socket.once("connect_error", (err) => resolve(err.message));
  });
}

/** Wait until `ms` have passed (the access token's `exp` is whole seconds). */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("#1414 session id on issued tokens", () => {
  it("mints a different session per login and keeps it through a refresh", async () => {
    const first = issueTokens(payload("u-sid"));
    const second = issueTokens(payload("u-sid"));
    const sidA = sessionIdOf(verifyAccessToken(first.accessToken));
    const sidB = sessionIdOf(verifyAccessToken(second.accessToken));
    expect(sidA).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(sidB).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(sidA).not.toBe(sidB);

    const rotated = await refreshAccessToken(first.refreshToken, async () => []);
    expect(sessionIdOf(verifyAccessToken(rotated.accessToken))).toBe(sidA);
  });

  it("mints a session on the first refresh of a token issued before #1414", async () => {
    const legacyRefresh = jwt.sign(
      { ...payload("u-legacy"), tokenId: "legacy-token", type: "refresh" },
      resolveJwtSecret().secret,
      { expiresIn: 60 },
    );
    const rotated = await refreshAccessToken(legacyRefresh, async () => []);
    expect(sessionIdOf(verifyAccessToken(rotated.accessToken))).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("treats a missing or foreign-shaped sid as no session id", () => {
    expect(sessionIdOf(undefined)).toBeUndefined();
    expect(sessionIdOf({})).toBeUndefined();
    expect(sessionIdOf({ sid: 42 })).toBeUndefined();
    expect(sessionIdOf({ sid: "x:y" })).toBeUndefined();
    expect(authSessionRoom("u", undefined)).toBe("auth-session:u:legacy");
  });
});

describe("#1414 access-token expiry", () => {
  it("closes the transport of a socket once its access token expires", async () => {
    const c = await connect(() => shortToken("u-exp", "01J00000000000000000000001", 2));

    await vi.waitFor(() => expect(c.reasons).toContain("transport close"), {
      timeout: 4_000,
      interval: 50,
    });
    expect(c.socket.connected).toBe(false);
  });

  it("revalidation closes a socket whose access token has expired", async () => {
    const c = await connect(() => issueTokens(payload("u-reval")).accessToken);
    // Two hours on: past the 1h token's `exp`, and well short of its expiry
    // timer, which runs on the real clock — so only the revalidation acts.
    const later = Date.now() + 2 * 60 * 60 * 1000;
    vi.spyOn(Date, "now").mockReturnValue(later);

    await revalidateLocalSockets(io, "sweep");

    await vi.waitFor(() => expect(c.reasons).toContain("transport close"));
  });

  it("revalidation keeps a socket whose access token is still valid", async () => {
    const c = await connect(() => issueTokens(payload("u-valid")).accessToken);

    await revalidateLocalSockets(io, "sweep");
    await sleep(50);

    expect(c.socket.connected).toBe(true);
    expect(c.reasons).toEqual([]);
  });

  it("keeps a client that re-handshakes with a renewed token before expiry", async () => {
    const sid = "01J00000000000000000000002";
    let token = shortToken("u-renew", sid, 2);
    const c = await connect(() => token);

    // What the UI does on a refresh-success: a fresh token, then disconnect()+connect().
    token = shortToken("u-renew", sid, 60);
    c.socket.disconnect();
    const renewed = new Promise<void>((resolve) => c.socket.once("auth:ok", () => resolve()));
    c.socket.connect();
    await renewed;

    await sleep(2_500);
    await revalidateLocalSockets(io, "sweep");
    await sleep(50);

    expect(c.socket.connected).toBe(true);
    // Only the client's own deliberate disconnect — never a server close.
    expect(c.reasons).toEqual(["io client disconnect"]);
  });

  it("lets a client whose transport closed at expiry reconnect with its renewed token", async () => {
    const sid = "01J00000000000000000000003";
    let token = shortToken("u-heal", sid, 2);
    const c = await connect(() => token, { reconnection: true });
    token = shortToken("u-heal", sid, 60);

    await vi.waitFor(() => expect(c.reasons).toContain("transport close"), { timeout: 4_000 });
    await vi.waitFor(() => expect(c.socket.connected).toBe(true), { timeout: 2_000 });
  });

  it("refuses a reconnect with the expired token", async () => {
    const token = shortToken("u-stale", "01J00000000000000000000004", 1);
    live.users.set("u-stale", payload("u-stale"));
    await sleep(1_100);
    expect(await handshakeOutcome(token)).toBe("TOKEN_EXPIRED");
  });

  it("arms one capped timer for a token that expires beyond the longest Node timer", async () => {
    // Uncapped, Node clamps the overflowing delay to 1 ms and the re-check
    // re-arms on every tick: a busy loop that keeps the socket open, so only
    // the overflow warnings show it.
    const overflows: string[] = [];
    const onWarning = (warning: Error) => {
      if (warning.name === "TimeoutOverflowWarning") overflows.push(warning.message);
    };
    process.on("warning", onWarning);
    try {
      const c = await connect(() =>
        shortToken("u-long", "01J00000000000000000000005", 40 * 86_400),
      );
      await sleep(100);
      expect(c.socket.connected).toBe(true);
      expect(overflows).toEqual([]);
    } finally {
      process.off("warning", onWarning);
    }
  });
});

/** The auth router alone, as `routes/index.ts` mounts it. */
function authApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/auth", authRouter());
  return app;
}

describe("#1414 logout ends that session's sockets only", () => {
  it("disconnects the logged-out session's sockets and keeps the user's other session", async () => {
    const a = issueTokens(payload("u-two"));
    const b = issueTokens(payload("u-two"));
    const tabA1 = await connect(() => a.accessToken);
    const tabA2 = await connect(() => a.accessToken);
    const otherDevice = await connect(() => b.accessToken);
    const otherUser = await connect(() => issueTokens(payload("u-else")).accessToken);

    const res = await request(authApp())
      .post("/api/auth/logout")
      .set("Authorization", `Bearer ${a.accessToken}`)
      .send({ refreshToken: a.refreshToken });
    expect(res.status).toBe(200);

    await vi.waitFor(() => expect(tabA1.reasons).toEqual(["io server disconnect"]));
    await vi.waitFor(() => expect(tabA2.reasons).toEqual(["io server disconnect"]));
    await sleep(50);
    expect(otherDevice.socket.connected).toBe(true);
    expect(otherUser.socket.connected).toBe(true);
  });

  it("refuses a reconnect with the logged-out session's still-valid access token", async () => {
    const a = issueTokens(payload("u-reconnect"));
    const b = issueTokens(payload("u-reconnect"));
    await connect(() => a.accessToken);

    await request(authApp())
      .post("/api/auth/logout")
      .set("Authorization", `Bearer ${a.accessToken}`)
      .send({ refreshToken: a.refreshToken });

    expect(await handshakeOutcome(a.accessToken)).toBe("UNAUTHORIZED");
    expect(await handshakeOutcome(b.accessToken)).toBe("connected");
  });

  it("closes a socket whose handshake was in flight when its session logged out", async () => {
    const a = issueTokens(payload("u-race"));
    live.users.set("u-race", payload("u-race"));
    let release!: () => void;
    live.gate = new Promise<void>((r) => (release = r));
    const socket = ioClient(`http://127.0.0.1:${port}`, {
      auth: { token: a.accessToken },
      transports: ["websocket"],
      reconnection: false,
    });
    open.push(socket);
    const reasons: string[] = [];
    socket.on("disconnect", (reason) => reasons.push(reason));
    await sleep(50);

    disconnectSessionSockets("u-race", sessionIdOf(verifyAccessToken(a.accessToken)));
    live.gate = undefined;
    release();

    await vi.waitFor(() => expect(reasons).toEqual(["io server disconnect"]));
  });

  it("ends the refresh token's session when the access token predates #1414", async () => {
    const legacyAccess = jwt.sign(payload("u-mixed"), resolveJwtSecret().secret, {
      expiresIn: 60,
    });
    const legacy = await connect(() => legacyAccess);
    const fresh = issueTokens(payload("u-mixed"));
    const current = await connect(() => fresh.accessToken);

    await request(authApp())
      .post("/api/auth/logout")
      .set("Authorization", `Bearer ${legacyAccess}`)
      .send({ refreshToken: fresh.refreshToken });

    await vi.waitFor(() => expect(legacy.reasons).toEqual(["io server disconnect"]));
    await vi.waitFor(() => expect(current.reasons).toEqual(["io server disconnect"]));
  });

  it("ignores a refresh token of another user", async () => {
    const mine = issueTokens(payload("u-me"));
    const theirs = issueTokens(payload("u-them"));
    const theirSocket = await connect(() => theirs.accessToken);

    await request(authApp())
      .post("/api/auth/logout")
      .set("Authorization", `Bearer ${mine.accessToken}`)
      .send({ refreshToken: theirs.refreshToken });

    await sleep(50);
    expect(theirSocket.socket.connected).toBe(true);
    expect(isSessionEnded("u-them", sessionIdOf(verifyAccessToken(theirs.accessToken)))).toBe(
      false,
    );
  });
});

describe("#1414 session revocation", () => {
  it("revokeAllUserSessions disconnects every socket of the user and no one else's", async () => {
    const one = await connect(() => issueTokens(payload("u-revoked")).accessToken);
    const two = await connect(() => issueTokens(payload("u-revoked")).accessToken);
    const bystander = await connect(() => issueTokens(payload("u-bystander")).accessToken);

    await revokeAllUserSessions("u-revoked");

    await vi.waitFor(() => expect(one.reasons).toEqual(["io server disconnect"]));
    await vi.waitFor(() => expect(two.reasons).toEqual(["io server disconnect"]));
    await sleep(50);
    expect(bystander.socket.connected).toBe(true);
  });
});
